"""
Tests for the local auth reset.

The schema comes from server/app/db.py rather than a copy, so a table or a cascade
that changes there fails here rather than leaving the script quietly clearing four
tables out of five.

Needs the development Postgres running, and runs inside the server's
environment, which is the one with psycopg:

    uv run --project server pytest .claude/skills/reset-auth-db/scripts/
"""

from __future__ import annotations

import importlib.util
import json
import sys
import uuid
from contextlib import contextmanager
from pathlib import Path

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict, make_conninfo

SCRIPT = Path(__file__).with_name("reset_auth_db.py")
REPOSITORY = SCRIPT.resolve().parents[4]


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


reset = _load("reset_auth_db", SCRIPT)
server_db = _load("authenticator_server_db", REPOSITORY / "server" / "app" / "db.py")
dev_database_url = _load(
    "dev_database_url", REPOSITORY / "server" / "deploy" / "dev_database_url.py"
)

# The dev database — there is no other one on this machine — reached through a
# schema of each test's own. That schema is the isolation: every URL handed to
# the script below carries a search_path, so the rows it clears are the ones the
# fixture just made, not the dev server's. TEST_DATABASE_URL rather than
# DATABASE_URL, so a shell holding the server's environment cannot quietly
# redirect the suite.
BASE_DATABASE_URL = dev_database_url.resolve(
    dev_database_url.DEV_DATABASE, "TEST_DATABASE_URL"
)


@contextmanager
def scratch_schema(prefix: str):
    """
    A schema of the caller's own in the dev database, and the URL to reach it by,
    dropped with everything in it afterwards.

    The assertion is not decoration. Everything below hands its URL to a script
    whose purpose is deleting accounts, and the only thing standing between that
    and the dev server's own rows is the search_path on this connection string.
    """
    schema = f"{prefix}_{uuid.uuid4().hex[:16]}"
    try:
        admin = psycopg.connect(BASE_DATABASE_URL, autocommit=True, connect_timeout=5)
    except psycopg.OperationalError as err:
        pytest.skip(f"no Postgres at {BASE_DATABASE_URL} ({err})")

    try:
        admin.execute(f'CREATE SCHEMA "{schema}"')
        params = conninfo_to_dict(BASE_DATABASE_URL)
        params["options"] = f"-c search_path={schema}"
        url = make_conninfo(**params)
        assert f"search_path={schema}" in url
        yield url
    finally:
        admin.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
        admin.close()


@pytest.fixture
def db() -> str:
    """
    A database on the real schema, holding two accounts and some throttling.
    Returns the URL to reach it by — a schema of this test's own, dropped when
    the test ends.
    """
    with scratch_schema("reset") as url:
        server_db.init_db(url)
        connection = psycopg.connect(url, autocommit=True)
        try:
            for index, email in enumerate(("one@example.com", "two@example.com")):
                user_id = f"user{index}"
                connection.execute(
                    "INSERT INTO users (id, email, auth_key_hash, kdf_params, wrapped_passphrase,"
                    " wrapped_recovery, created_at, updated_at, verified_at)"
                    " VALUES (%s, %s, 'hash', '{}', 'wrapped', 'wrapped', 0, 0, 0)",
                    (user_id, email),
                )
                connection.execute(
                    "INSERT INTO vaults (user_id, version, ciphertext, updated_at)"
                    " VALUES (%s, 1, %s, 0)",
                    (user_id, b"\x00"),
                )
                connection.execute(
                    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at)"
                    " VALUES (%s, %s, 0, 99)",
                    (f"token{index}", user_id),
                )
                connection.execute(
                    "INSERT INTO email_challenges (id, user_id, purpose, code_hash, attempts,"
                    " created_at, code_expires_at, expires_at)"
                    " VALUES (%s, %s, 'register', 'h', 0, 0, 9, 9)",
                    (f"challenge{index}", user_id),
                )
                connection.execute(
                    "INSERT INTO throttle_events (kind, key, at) VALUES ('code_send', %s, 0)",
                    (f"email:{email}",),
                )
                connection.execute(
                    "INSERT INTO throttle_events (kind, key, at) VALUES ('login_failure', %s, 0)",
                    (f"{email}|10.0.0.1",),
                )
            # Keyed by IP, so no address owns it.
            connection.execute(
                "INSERT INTO throttle_events (kind, key, at) VALUES ('registration', '10.0.0.1', 0)"
            )
            # Registrations still waiting on their codes: one for an address above,
            # one for an address that has no account at all.
            for index, email in enumerate(("one@example.com", "three@example.com")):
                connection.execute(
                    "INSERT INTO pending_registrations (id, email, code_hash, attempts,"
                    " created_at, code_expires_at, expires_at) VALUES (%s, %s, 'h', 0, 0, 9, 9)",
                    (f"pending{index}", email),
                )
        finally:
            connection.close()

        yield url


@pytest.fixture
def empty_db() -> str:
    """A database with no auth tables in it at all."""
    with scratch_schema("empty") as url:
        yield url


def counts(url: str) -> dict[str, int | None]:
    connection = psycopg.connect(url)
    try:
        return reset.table_counts(connection)
    finally:
        connection.close()


def query(url: str, sql: str, params=()) -> list[tuple]:
    connection = psycopg.connect(url)
    try:
        return list(connection.execute(sql, params))
    finally:
        connection.close()


def run(*argv: str) -> int:
    return reset.main(list(argv))


def test_a_run_without_yes_changes_nothing(db: str) -> None:
    before = counts(db)
    assert run("--database-url", db) == 0
    assert counts(db) == before


def test_yes_clears_every_table(db: str) -> None:
    assert run("--database-url", db, "--yes") == 0
    assert counts(db) == {t: 0 for t in reset.ALL_TABLES}


def test_the_schema_survives_so_the_server_needs_no_restart(db: str) -> None:
    run("--database-url", db, "--yes")
    connection = psycopg.connect(db)
    try:
        assert reset.existing_tables(connection) >= set(reset.ALL_TABLES)
    finally:
        connection.close()


def test_one_address_leaves_the_other_account_intact(db: str) -> None:
    assert run("--database-url", db, "--email", "one@example.com", "--yes") == 0
    after = counts(db)
    assert after["users"] == 1
    # Its vault, session, outstanding code and pending registration went with it.
    assert after["vaults"] == 1
    assert after["sessions"] == 1
    assert after["email_challenges"] == 1
    assert after["pending_registrations"] == 1

    remaining = {row[0] for row in query(db, "SELECT email FROM users")}
    assert remaining == {"two@example.com"}
    # The IP-keyed registration counter cannot be attributed to an address, so it
    # stays; the two the address does own are gone.
    kinds = {
        row[0]
        for row in query(
            db, "SELECT kind FROM throttle_events WHERE key LIKE %s", ("%one@example.com%",)
        )
    }
    assert kinds == set()
    assert query(
        db, "SELECT COUNT(*) FROM throttle_events WHERE kind = 'registration'"
    )[0][0] == 1


def test_an_address_is_normalised_the_way_the_server_stores_it(db: str) -> None:
    assert run("--database-url", db, "--email", "  ONE@Example.COM ", "--yes") == 0
    assert counts(db)["users"] == 1


def test_throttles_only_leaves_the_accounts(db: str) -> None:
    assert run("--database-url", db, "--throttles-only", "--yes") == 0
    after = counts(db)
    assert after["throttle_events"] == 0
    assert after["users"] == 2
    assert after["sessions"] == 2
    assert after["pending_registrations"] == 2


def test_a_pending_registration_without_an_account_can_be_cleared_by_address(db: str) -> None:
    """`three@example.com` has asked for a code but answered nothing: no user row."""
    assert run("--database-url", db, "--email", "three@example.com", "--yes") == 0
    after = counts(db)
    assert after["users"] == 2
    assert after["pending_registrations"] == 1


def test_keep_throttles_leaves_the_limits(db: str) -> None:
    assert run("--database-url", db, "--keep-throttles", "--yes") == 0
    after = counts(db)
    assert after["users"] == 0
    assert after["throttle_events"] == 5


def test_the_two_throttle_flags_are_refused_together(db: str) -> None:
    with pytest.raises(SystemExit) as raised:
        run("--database-url", db, "--throttles-only", "--keep-throttles", "--yes")
    assert raised.value.code == 2


@pytest.mark.parametrize(
    "url",
    [
        "postgresql://authenticator:pw@authenticator.moates.com.au:5432/authenticator",
        # The name the app container reaches it by inside the compose project.
        "postgresql://authenticator:pw@postgres:5432/authenticator",
        "postgresql://authenticator:pw@10.0.0.5:5432/authenticator",
        # A local host among remote ones is still a way to reach a remote one.
        "postgresql://authenticator:pw@127.0.0.1,postgres:5432/authenticator",
    ],
)
def test_anything_not_on_this_machine_is_refused(url: str) -> None:
    assert run("--database-url", url, "--yes") == 2


def test_the_local_dev_database_is_allowed() -> None:
    assert reset.is_local(reset.DEFAULT_DATABASE_URL)


def test_a_database_that_cannot_be_reached_is_an_error() -> None:
    assert run("--database-url", "postgresql://nobody@127.0.0.1:1/nothing", "--yes") == 2


def test_a_database_with_no_tables_is_not_an_error(empty_db: str) -> None:
    assert run("--database-url", empty_db, "--yes") == 0


def test_a_database_too_large_to_be_local_is_refused(db: str) -> None:
    connection = psycopg.connect(db, autocommit=True)
    try:
        for index in range(reset.LARGE_DB_USERS + 1):
            connection.execute(
                "INSERT INTO users (id, email, auth_key_hash, kdf_params, wrapped_passphrase,"
                " wrapped_recovery, created_at, updated_at)"
                " VALUES (%s, %s, 'h', '{}', 'w', 'w', 0, 0)",
                (f"bulk{index}", f"bulk{index}@example.com"),
            )
    finally:
        connection.close()

    assert run("--database-url", db, "--yes") == 2
    assert counts(db)["users"] > reset.LARGE_DB_USERS

    # And goes ahead when told the URL really was the one meant.
    assert run("--database-url", db, "--yes", "--force") == 0
    assert counts(db)["users"] == 0


def test_the_default_target_is_what_the_dev_server_uses() -> None:
    """
    The default here and the URL `npm run server` passes have to agree, or the
    skill quietly cleans a database the server is not using. Both come through
    dev_database_url.py, so what this checks is that neither has gone back to
    hardcoding an address of its own.
    """
    scripts = json.loads((REPOSITORY / "package.json").read_text())["scripts"]
    assert "deploy/dev_database_url.py" in scripts["server"]
    assert reset.DEFAULT_DATABASE_URL == dev_database_url.dev_database_url()


def test_the_guard_follows_the_address_the_dev_server_moves_to() -> None:
    """
    The Windows host is reached by an address that changes when WSL restarts, so
    the guard cannot be a fixed list: whatever the resolver currently points at
    has to be allowed, or the skill refuses the very database it is for.
    """
    assert reset.is_local(reset.DEFAULT_DATABASE_URL)
    assert dev_database_url.dev_host() in reset.local_hosts()
