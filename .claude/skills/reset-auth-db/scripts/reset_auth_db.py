#!/usr/bin/env python3.12
"""
Empties the local sync server's auth tables, for testing a sign-up from scratch.

Rows are deleted rather than the schema dropped: uvicorn --reload holds a pool of
open connections, and taking the tables out from under them would leave the next
request failing rather than starting clean. Deleting rows needs no restart.

Nothing here is reversible, so a run without --yes only reports what it would do.
"""

from __future__ import annotations

import argparse
import importlib.util
import socket
import sys
from pathlib import Path

import psycopg
from psycopg.conninfo import conninfo_to_dict

REPOSITORY = Path(__file__).resolve().parents[4]


def _load_dev_database_url():
    """
    The same module `npm run server` and the test suite use, so this skill and
    the server cannot end up pointing at different databases. Loaded by path
    because it lives in the server tree, not on sys.path.
    """
    path = REPOSITORY / "server" / "deploy" / "dev_database_url.py"
    spec = importlib.util.spec_from_file_location("dev_database_url", path)
    assert spec and spec.loader, f"cannot load {path}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


dev_database_url = _load_dev_database_url()

# What `npm run server` passes, and what server/README.md has the dev server use.
DEFAULT_DATABASE_URL = dev_database_url.dev_database_url()

# Always allowed, whatever else resolves.
LOOPBACK_HOSTS = frozenset({"", "localhost", "127.0.0.1", "::1", "/var/run/postgresql"})

# server/app/db.py. Children cascade from users, but they are cleared explicitly
# too, so the result does not depend on the cascade being in place.
USER_TABLES = ("email_challenges", "sessions", "vaults", "users")

# A registration whose code is still in transit. Keyed by email rather than by
# user — the account it would create does not exist yet — so a user cascade
# never touches it and it is cleared on its own.
PENDING_TABLE = "pending_registrations"

# Failed logins, registrations per IP and codes sent per address. No foreign key,
# so a user cascade leaves these behind — which is what makes the second attempt
# at a sign-up a 429 rather than a fresh start.
THROTTLE_TABLE = "throttle_events"

ALL_TABLES = ("users", "vaults", "sessions", "email_challenges", PENDING_TABLE, THROTTLE_TABLE)

# A development database holds a handful of test accounts. Many more than this
# and the URL is probably not the one that was meant.
LARGE_DB_USERS = 25


def local_hosts() -> set[str]:
    """
    Every address that means "Postgres on this machine" right now.

    Loopback, plus however WSL2 currently reaches the Windows host — the gateway
    address, which moves when WSL restarts, and the names Docker Desktop keeps in
    /etc/hosts. Worked out rather than listed, so this cannot drift away from
    what `npm run server` connects to.
    """
    hosts = set(LOOPBACK_HOSTS)
    gateway = dev_database_url.gateway_host()
    if gateway:
        hosts.add(gateway)
    for name in dev_database_url.FALLBACK_HOSTS:
        hosts.add(name)
        try:
            hosts.add(socket.gethostbyname(name))
        except OSError:
            pass
    return hosts


def is_local(database_url: str) -> bool:
    """
    Whether the URL names Postgres on this machine. A comma-separated host list
    is a libpq failover list; every entry has to be local for the answer to be
    yes.

    This is the guard that keeps the droplet safe: its database is reached as
    `postgres` from inside its compose project, which is not any of these. A
    tunnel forwarding it to a local port would slip past — the account-count
    check below is what stands behind this for that case.
    """
    host = conninfo_to_dict(database_url).get("host", "")
    if not isinstance(host, str):
        return False
    allowed = local_hosts()
    return all(part.strip() in allowed for part in host.split(","))


def existing_tables(connection: psycopg.Connection) -> set[str]:
    rows = connection.execute(
        "SELECT tablename FROM pg_tables WHERE schemaname = current_schema()"
    )
    return {row[0] for row in rows}


def table_counts(connection: psycopg.Connection) -> dict[str, int | None]:
    """Row counts per table, or None for a table this database does not have yet."""
    present = existing_tables(connection)
    counts: dict[str, int | None] = {}
    for table in ALL_TABLES:
        if table not in present:
            counts[table] = None
            continue
        counts[table] = int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
    return counts


def report(counts: dict[str, int | None], heading: str) -> None:
    print(f"\n{heading}")
    for table, count in counts.items():
        print(f"  {table:<18} {'-' if count is None else count}")


def normalise_email(email: str) -> str:
    """The same normalisation the server applies before it stores an address."""
    return email.strip().lower()


def delete_users(connection: psycopg.Connection, emails: list[str] | None) -> None:
    """
    Clears every account, or just the addresses named — including a registration
    still waiting on its code, which exists as an email in `pending_registrations`
    rather than an account. The children go first so the result is the same
    whether or not the cascade is in place.
    """
    if emails is None:
        for table in USER_TABLES + (PENDING_TABLE,):
            connection.execute(f"DELETE FROM {table}")
        return

    connection.execute(f"DELETE FROM {PENDING_TABLE} WHERE email = ANY(%s)", (emails,))

    ids = [
        row[0]
        for row in connection.execute("SELECT id FROM users WHERE email = ANY(%s)", (emails,))
    ]
    if not ids:
        return

    for table in ("email_challenges", "sessions", "vaults"):
        connection.execute(f"DELETE FROM {table} WHERE user_id = ANY(%s)", (ids,))
    connection.execute("DELETE FROM users WHERE id = ANY(%s)", (ids,))


def delete_throttles(connection: psycopg.Connection, emails: list[str] | None) -> None:
    """
    Clears the throttle counters.

    Per address, only two of the three kinds can be found: `code_send` is keyed
    `email:<address>` and `login_failure` `<address>|<ip>`, but `registration` is
    keyed by IP alone and cannot be attributed to an account. A registration 429
    therefore needs the whole table, which is what passing no address does.
    """
    if emails is None:
        connection.execute(f"DELETE FROM {THROTTLE_TABLE}")
        return

    for email in emails:
        connection.execute(
            f"DELETE FROM {THROTTLE_TABLE} WHERE kind = 'code_send' AND key = %s",
            (f"email:{email}",),
        )
        connection.execute(
            f"DELETE FROM {THROTTLE_TABLE} WHERE kind = 'login_failure' AND key LIKE %s",
            (f"{email}|%",),
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Empty the local auth tables for a clean sign-up test.",
    )
    parser.add_argument(
        "--database-url",
        help=f"Postgres to clean. Default: {DEFAULT_DATABASE_URL}",
    )
    parser.add_argument(
        "--email",
        action="append",
        metavar="ADDRESS",
        help="Clear only this account, repeatable. Default is every account.",
    )
    parser.add_argument(
        "--throttles-only",
        action="store_true",
        help="Reset the rate limits and leave the accounts alone (fixes a 429).",
    )
    parser.add_argument(
        "--keep-throttles",
        action="store_true",
        help="Clear accounts but leave the rate limits standing.",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Actually delete. Without it this only reports what it would do.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help=f"Proceed even with more than {LARGE_DB_USERS} accounts present.",
    )
    args = parser.parse_args(argv)

    if args.throttles_only and args.keep_throttles:
        parser.error("--throttles-only and --keep-throttles ask for opposite things")

    target = args.database_url or DEFAULT_DATABASE_URL

    if not is_local(target):
        print(
            f"Refusing: {target} does not name a database on this machine.\n"
            "This skill is for the local development server only.",
            file=sys.stderr,
        )
        return 2

    emails = [normalise_email(address) for address in args.email] if args.email else None

    try:
        connection = psycopg.connect(target, autocommit=True, connect_timeout=5)
    except psycopg.OperationalError as err:
        print(
            f"Could not reach Postgres at {target}\n{err}\n"
            "That is the development Postgres on Windows — check the service is"
            " running.",
            file=sys.stderr,
        )
        return 2

    try:
        before = table_counts(connection)
        print(f"Database: {target}")
        report(before, "Rows now:")

        if all(count is None for count in before.values()):
            print("\nNo auth tables here — nothing to clean.")
            print("The dev server creates them on first start.")
            return 0

        users_now = before["users"] or 0
        if not args.throttles_only and users_now > LARGE_DB_USERS and not args.force:
            print(
                f"\nRefusing: {users_now} accounts is more than a development database"
                f" should hold ({LARGE_DB_USERS}).\nCheck the URL, then pass --force if"
                " it really is the one you meant.",
                file=sys.stderr,
            )
            return 2

        if args.throttles_only:
            plan = "the rate limits"
        elif emails is None:
            plan = "every account" + ("" if args.keep_throttles else ", and the rate limits")
        else:
            plan = ", ".join(emails) + ("" if args.keep_throttles else ", and their rate limits")

        if not args.yes:
            print(f"\nWould clear: {plan}.")
            print("Nothing has been changed. Add --yes to go ahead.")
            return 0

        with connection.transaction():
            if not args.throttles_only:
                delete_users(connection, emails)
            if not args.keep_throttles:
                delete_throttles(connection, emails)

        print(f"\nCleared: {plan}.")
        report(table_counts(connection), "Rows after:")
        if not args.throttles_only and emails is None:
            print(
                "\nThe app on the device still holds its own account record and"
                "\nvault key, so it will look signed in to an account the server has"
                "\nforgotten. Sign out in the app before trying a fresh sign-up."
            )
        return 0
    finally:
        connection.close()


if __name__ == "__main__":
    sys.exit(main())
