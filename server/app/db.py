"""
Postgres access. Deliberately psycopg and raw SQL rather than an ORM: there are
six tables and every query in the server is a single statement.

Timestamps are integer epoch seconds throughout, stored as BIGINT. `vaults.ciphertext`
is a BYTEA holding the exact byte sequence the device wrote to its own disk — the
server has no idea what is inside it.

Connections come from a pool opened once at startup. Each is autocommit, with
transactions taken explicitly by the handful of endpoints that need more than one
statement to be atomic; rows come back as dicts.
"""

from __future__ import annotations

import logging
import time

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

log = logging.getLogger("authenticator")

# Held while the schema is created, so two workers starting together cannot
# deadlock against each other inside CREATE TABLE IF NOT EXISTS. The number is
# arbitrary but must not collide with another advisory lock on the same database.
SCHEMA_LOCK_ID = 0x4155_5448  # "AUTH"

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id                  TEXT PRIMARY KEY,
    email               TEXT NOT NULL UNIQUE,
    auth_key_hash       TEXT NOT NULL,
    -- The client stretches the passphrase twice: `kdf_params` makes the
    -- encryption key that unwraps the data key, `auth_kdf_params` the auth key
    -- hashed into the column above. Both are stored per account so raising
    -- either later leaves existing accounts working on what they were made with.
    kdf_params          TEXT NOT NULL,
    auth_kdf_params     TEXT NOT NULL,
    wrapped_passphrase  TEXT NOT NULL,
    wrapped_recovery    TEXT NOT NULL,
    created_at          BIGINT NOT NULL,
    updated_at          BIGINT NOT NULL,
    -- NULL until a code sent to that address comes back. No session is issued
    -- before it is set, and every session is refused while it is NULL.
    verified_at         BIGINT
);

CREATE TABLE IF NOT EXISTS vaults (
    user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    version     BIGINT NOT NULL DEFAULT 0,
    ciphertext  BYTEA,
    updated_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  BIGINT NOT NULL,
    expires_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

-- An emailed code in flight. At most one row per account: issuing a code drops
-- whatever was outstanding, and verifying deletes the row, so a code works once
-- and only the newest one works at all.
--
-- The code and the challenge expire separately. `code_expires_at` is the five
-- minutes the digits are good for; `expires_at` is how long the client may keep
-- asking for a fresh one before it has to start from the passphrase again.
CREATE TABLE IF NOT EXISTS email_challenges (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    purpose          TEXT NOT NULL,
    code_hash        TEXT NOT NULL,
    attempts         INTEGER NOT NULL DEFAULT 0,
    created_at       BIGINT NOT NULL,
    code_expires_at  BIGINT NOT NULL,
    expires_at       BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS email_challenges_expiry_idx ON email_challenges(expires_at);

-- A registration that has sent its code but not yet answered it. The account
-- does not exist until the code comes back: `/v1/register` takes nothing but
-- the address, and the key material arrives with the code at `/v1/verify` —
-- which is what lets the client run its slow key derivation while the code is
-- in transit instead of before it can be sent. One row per address; asking
-- again replaces it.
CREATE TABLE IF NOT EXISTS pending_registrations (
    id               TEXT PRIMARY KEY,
    email            TEXT NOT NULL UNIQUE,
    code_hash        TEXT NOT NULL,
    attempts         INTEGER NOT NULL DEFAULT 0,
    created_at       BIGINT NOT NULL,
    code_expires_at  BIGINT NOT NULL,
    expires_at       BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_registrations_expiry_idx ON pending_registrations(expires_at);

-- Failed logins and registrations, for the application-level throttle that sits
-- underneath nginx's rate limiting.
CREATE TABLE IF NOT EXISTS throttle_events (
    kind  TEXT NOT NULL,
    key   TEXT NOT NULL,
    at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS throttle_lookup_idx ON throttle_events(kind, key, at);
"""

# Additive column migrations for databases created before a column existed.
# `CREATE TABLE IF NOT EXISTS` leaves an existing table alone, so anything added
# to a table after the first deploy has to be spliced in here too.
#
# Accounts that predate email verification come out of this unverified rather
# than grandfathered in. Their next sign-in emails them a code and sets the
# column, which is the same path a new account takes; what it costs them is one
# re-login, since sessions are refused while the column is NULL.
# `auth_kdf_params` arrives nullable here rather than NOT NULL, because a row
# that predates it has nothing to fill it with. Such an account cannot sign in
# regardless: its `auth_key_hash` was made from the single derivation this split
# replaced, so the auth key its device sends now will not match whatever it
# stored then. Re-registering the address is the way back, and deleting the
# unverified leftover is what `/v1/register` already does.
MIGRATIONS = (
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_at BIGINT",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_kdf_params TEXT",
)


def connect(database_url: str) -> psycopg.Connection:
    """
    A single connection outside the pool, for startup and for scripts. Autocommit,
    with transactions taken explicitly by whoever needs one.
    """
    return psycopg.connect(database_url, autocommit=True, row_factory=dict_row)


def build_pool(
    database_url: str, min_size: int = 1, max_size: int = 10
) -> ConnectionPool:
    """
    The pool the app serves from. Opened eagerly and with `wait` below, so a
    server that cannot reach its database fails at startup rather than at the
    first request that needed it.
    """
    return ConnectionPool(
        database_url,
        min_size=min_size,
        max_size=max_size,
        kwargs={"autocommit": True, "row_factory": dict_row},
        open=False,
    )


def wait_for_database(database_url: str, timeout: float = 30.0) -> None:
    """
    Postgres and the app start together under compose, and the database takes a
    moment longer. Retries rather than crash-looping the container, and gives up
    loudly if the address is simply wrong.
    """
    deadline = time.monotonic() + timeout
    attempt = 0
    while True:
        try:
            connect(database_url).close()
            return
        except psycopg.OperationalError:
            attempt += 1
            if time.monotonic() >= deadline:
                raise
            if attempt == 1:
                log.info("Waiting for Postgres to accept connections")
            time.sleep(0.5)


def init_db(database_url: str) -> None:
    wait_for_database(database_url)
    connection = connect(database_url)
    try:
        with connection.transaction():
            connection.execute("SELECT pg_advisory_xact_lock(%s)", (SCHEMA_LOCK_ID,))
            connection.execute(SCHEMA)
            for statement in MIGRATIONS:
                connection.execute(statement)
    finally:
        connection.close()
