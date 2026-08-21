"""
Shared fixtures. Every test gets a throwaway Postgres schema and its own app.

A schema rather than a database: it is created and dropped in milliseconds, where
CREATE DATABASE is closer to a tenth of a second and would dominate the run. The
connection string carries `search_path`, so the server's own SQL is unqualified
and identical to what it runs in production.

That schema is what keeps the suite off the dev server's rows, and it is the
whole of it — the tests run in the same `authenticator` database the dev server
uses. Nothing here names `public` or qualifies a table, so nothing here can
reach out of the schema it was given; what a crashed run leaves behind is an
empty `test_…` schema, not a changed account.
"""

import sys
import uuid
from dataclasses import replace
from pathlib import Path

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.rows import dict_row

from app.config import Settings
from app.mail import MemoryMailer
from app.main import create_app

# Where the development Postgres is. Worked out rather than hardcoded — it runs
# on Windows, and the address WSL2 reaches it by moves when WSL restarts.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "deploy"))
from dev_database_url import DEV_DATABASE, resolve  # noqa: E402

MISSING_DATABASE = """
Cannot reach Postgres at {url}

The suite needs the development Postgres — the one on Windows, which
server/README.md covers. Check the service is running, then:

    python3.12 server/deploy/dev_database_url.py

Set TEST_DATABASE_URL to point somewhere else.
"""


@pytest.fixture(scope="session")
def base_database_url() -> str:
    # The dev database, and never the droplet's — the schema per test below is
    # what keeps the two apart. TEST_DATABASE_URL, not DATABASE_URL, so that a
    # shell with the server's environment already in it does not silently decide
    # where the suite runs.
    url = resolve(DEV_DATABASE, "TEST_DATABASE_URL")
    try:
        psycopg.connect(url, connect_timeout=5).close()
    except psycopg.OperationalError as err:
        pytest.exit(MISSING_DATABASE.format(url=url) + f"\n{err}", returncode=1)
    return url


@pytest.fixture
def database_url(base_database_url) -> str:
    """A schema of this test's own, dropped with everything in it when it ends."""
    schema = f"test_{uuid.uuid4().hex[:16]}"
    admin = psycopg.connect(base_database_url, autocommit=True)
    try:
        admin.execute(f'CREATE SCHEMA "{schema}"')

        params = conninfo_to_dict(base_database_url)
        params["options"] = f"-c search_path={schema}"
        yield make_conninfo(**params)
    finally:
        admin.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
        admin.close()


@pytest.fixture
def db(database_url):
    """
    A connection to the test's own schema, for reaching past the API and setting
    up state it will not. Autocommit, so a write here is visible to the server
    immediately.
    """
    connection = psycopg.connect(database_url, autocommit=True, row_factory=dict_row)
    try:
        yield connection
    finally:
        connection.close()


@pytest.fixture
def mailbox() -> MemoryMailer:
    """Where the verification codes land. Shared by every client in a test."""
    return MemoryMailer()


@pytest.fixture
def settings() -> Settings:
    """
    Production-shaped defaults, with a placeholder database. `make_client` puts
    the real URL in; tests that need no database — the mailer's, for one — take
    this directly and skip standing a schema up.
    """
    return Settings(
        database_url="postgresql://placeholder/placeholder",
        # One connection each. A test makes its requests one at a time, and a
        # test that builds several clients would otherwise hold a pool per client
        # against a server with a default of 100.
        pool_min_size=1,
        pool_max_size=2,
        token_ttl_seconds=3600,
        max_ciphertext_bytes=1024 * 1024,
        max_users=0,
        max_login_attempts=10,
        login_attempt_window_seconds=900,
        max_registrations_per_ip=5,
        registration_window_seconds=3600,
        code_ttl_seconds=900,
        challenge_ttl_seconds=1800,
        max_code_attempts=5,
        max_codes_per_email=5,
        max_codes_per_ip=20,
        code_window_seconds=900,
        google_client_id="test-client-id.apps.googleusercontent.com",
        google_client_secret="test-client-secret",
        google_refresh_token="test-refresh-token",
        email_from="Authenticator <no-reply@example.com>",
        enable_docs=False,
        # Off unless a test asks for it, so the fixed code is never quietly
        # available to the rest of the suite.
        test_account_email="",
    )


@pytest.fixture
def make_client(database_url, mailbox, settings):
    """
    Builds a client with production-shaped defaults. Pass overrides to exercise a
    limit without waiting for the real one, e.g. `make_client(max_login_attempts=2)`,
    or `mailer=` to stand in a sender that fails. Two clients from the same test
    share the database, which is how a restart is simulated.
    """
    base = replace(settings, database_url=database_url)

    pools = []

    def _make(*, mailer=None, **overrides) -> TestClient:
        app = create_app(replace(base, **overrides), mailer=mailer or mailbox)
        # A TestClient used without its context manager never runs the shutdown
        # that would return these, and the schema cannot be dropped while they
        # are still holding objects in it.
        pools.append(app.state.db_pool)
        return TestClient(app)

    yield _make

    for pool in pools:
        pool.close()


@pytest.fixture
def client(make_client) -> TestClient:
    return make_client()
