#!/usr/bin/env python3.12
"""
Moves an existing SQLite database into Postgres, once.

Run this on the droplet with the old `authenticator.db` in hand and the new
Postgres up, before pointing the server at it. Every table comes across,
`sessions` included: those rows are what keep the phones already out there
signed in, and dropping them would ask every user for both factors again.

Nothing is written until `--yes`. A run without it reports what is on each side
and stops, which is also the way to check the file is the one you meant.

The source is opened read-only but the directory holding it must still be
writable: the old database is in WAL mode, and SQLite cannot open one of those
without being able to reach its `-wal` and `-shm` sidecars. Stop the old server
first, so what is read is a database nothing is still writing to.

    python3.12 migrate_sqlite_to_postgres.py --sqlite /data/authenticator.db \\
        --database-url postgresql://authenticator:PASSWORD@127.0.0.1:5432/authenticator
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from pathlib import Path

# Importable when run from the server directory, which is where the deploy
# scripts are run from.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import connect, init_db  # noqa: E402

DEFAULT_SQLITE_PATH = Path("/data/authenticator.db")

# In insertion order: a child cannot land before the user it references. The
# columns are the full current schema; a source database written by an older
# version may be missing some, and those are left to Postgres' own defaults.
TABLES: dict[str, tuple[str, ...]] = {
    "users": (
        "id",
        "email",
        "auth_key_hash",
        "kdf_params",
        "wrapped_passphrase",
        "wrapped_recovery",
        "created_at",
        "updated_at",
        "verified_at",
    ),
    "vaults": ("user_id", "version", "ciphertext", "updated_at"),
    "sessions": ("token_hash", "user_id", "created_at", "expires_at"),
    "email_challenges": (
        "id",
        "user_id",
        "purpose",
        "code_hash",
        "attempts",
        "created_at",
        "code_expires_at",
        "expires_at",
    ),
    "pending_registrations": (
        "id",
        "email",
        "code_hash",
        "attempts",
        "created_at",
        "code_expires_at",
        "expires_at",
    ),
    "throttle_events": ("kind", "key", "at"),
}


def source_tables(source: sqlite3.Connection) -> set[str]:
    rows = source.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    return {row[0] for row in rows}


def source_columns(source: sqlite3.Connection, table: str) -> list[str]:
    return [row[1] for row in source.execute(f"PRAGMA table_info({table})")]


def read_table(
    source: sqlite3.Connection, table: str, columns: list[str]
) -> list[tuple]:
    quoted = ", ".join(f'"{column}"' for column in columns)
    return list(source.execute(f"SELECT {quoted} FROM {table}"))


def copy(source: sqlite3.Connection, target, dry_run: bool) -> dict[str, int]:
    """Returns the row count moved (or that would be moved) per table."""
    present = source_tables(source)
    moved: dict[str, int] = {}

    for table, wanted in TABLES.items():
        if table not in present:
            # An older database predating this table. Nothing to carry over.
            moved[table] = 0
            continue

        available = source_columns(source, table)
        columns = [column for column in wanted if column in available]
        rows = read_table(source, table, columns)
        moved[table] = len(rows)
        if dry_run or not rows:
            continue

        # `ciphertext` arrives as bytes from SQLite and goes to BYTEA unchanged;
        # everything else is text or an integer and needs no conversion.
        placeholders = ", ".join(["%s"] * len(columns))
        quoted = ", ".join(f'"{column}"' for column in columns)
        target.cursor().executemany(
            f"INSERT INTO {table} ({quoted}) VALUES ({placeholders})", rows
        )

    return moved


def target_counts(target) -> dict[str, int]:
    return {
        table: target.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()["n"]
        for table in TABLES
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--sqlite",
        type=Path,
        default=DEFAULT_SQLITE_PATH,
        help=f"the database to read (default {DEFAULT_SQLITE_PATH})",
    )
    parser.add_argument(
        "--database-url",
        default=os.environ.get("DATABASE_URL", ""),
        help="the Postgres to write (default $DATABASE_URL)",
    )
    parser.add_argument("--yes", action="store_true", help="actually write")
    parser.add_argument(
        "--force",
        action="store_true",
        help="write even though the target already holds rows",
    )
    args = parser.parse_args()

    if not args.database_url:
        parser.error("no --database-url and no DATABASE_URL in the environment")
    if not args.sqlite.exists():
        parser.error(f"no such file: {args.sqlite}")

    try:
        source = sqlite3.connect(f"file:{args.sqlite}?mode=ro", uri=True)
        source.execute("SELECT 1 FROM sqlite_master LIMIT 1")
    except sqlite3.OperationalError as err:
        # Almost always a WAL database on a read-only mount: the open succeeds
        # and the first read is what fails, which is not an obvious message to
        # be handed.
        print(
            f"Could not read {args.sqlite}: {err}\n"
            "A WAL database needs its directory to be writable even to be read.\n"
            "Check the mount is not :ro, and that the old server is stopped.",
            file=sys.stderr,
        )
        return 2

    init_db(args.database_url)
    target = connect(args.database_url)

    try:
        before = target_counts(target)
        occupied = {table: n for table, n in before.items() if n}
        if occupied and not args.force:
            print(f"The target already holds rows: {occupied}")
            print("Migrating on top of them would duplicate accounts. Use --force if")
            print("that is genuinely what you want, or empty it first.")
            return 1

        if not args.yes:
            counts = copy(source, target, dry_run=True)
            print(f"Reading {args.sqlite}")
            for table, n in counts.items():
                print(f"  {table:<24} {n:>6} rows -> {before[table]} now in Postgres")
            print("\nNothing written. Re-run with --yes.")
            return 0

        # One transaction: a half-migrated database is worse than none, since
        # the accounts that made it across would look complete.
        with target.transaction():
            counts = copy(source, target, dry_run=False)

        for table, n in counts.items():
            print(f"  {table:<24} {n:>6} rows moved")
        print(f"\nDone. {counts['users']} accounts are now in Postgres.")
        print(f"Keep {args.sqlite} until the server has been running on it for a while.")
        return 0
    finally:
        source.close()
        target.close()


if __name__ == "__main__":
    raise SystemExit(main())
