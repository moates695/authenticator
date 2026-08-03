"""
SQLite access. Deliberately the standard library rather than an ORM: there are
four tables and the box has 750MB free.

Timestamps are integer epoch seconds throughout. `vaults.ciphertext` is the exact
byte sequence the device wrote to its own disk — the server has no idea what is
inside it.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id                  TEXT PRIMARY KEY,
    email               TEXT NOT NULL UNIQUE,
    auth_key_hash       TEXT NOT NULL,
    kdf_params          TEXT NOT NULL,
    wrapped_passphrase  TEXT NOT NULL,
    wrapped_recovery    TEXT NOT NULL,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vaults (
    user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    version     INTEGER NOT NULL DEFAULT 0,
    ciphertext  BLOB,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

-- Failed logins and registrations, for the application-level throttle that sits
-- underneath nginx's rate limiting.
CREATE TABLE IF NOT EXISTS throttle_events (
    kind  TEXT NOT NULL,
    key   TEXT NOT NULL,
    at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS throttle_lookup_idx ON throttle_events(kind, key, at);
"""


def connect(db_path: Path) -> sqlite3.Connection:
    """Opens a connection with transactions managed explicitly by the caller."""
    connection = sqlite3.connect(db_path, isolation_level=None, timeout=10.0)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 10000")
    return connection


def init_db(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = connect(db_path)
    try:
        # WAL survives across connections; setting it once at startup is enough.
        connection.execute("PRAGMA journal_mode = WAL")
        connection.executescript(SCHEMA)
    finally:
        connection.close()
