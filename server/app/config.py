"""
Runtime configuration. Everything is overridable by environment variable so the
container can be retuned without a rebuild; the defaults are what production
runs with.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

# Deliberately has no default. A server that cannot reach its database should
# fail to boot with a clear reason rather than quietly opening a local one, and
# there is no sensible guess: dev and the droplet name different hosts, and the
# credentials are per-environment.
DATABASE_URL_ENV = "DATABASE_URL"

# Client-side Argon2id parameters handed to a device that has never seen a given
# account. Each account stores its own copy at registration, so raising these
# later affects new accounts immediately and existing ones only when they next
# change their passphrase.
#
# There are two, because the passphrase is stretched twice for two different
# jobs. DEFAULT_KDF makes the encryption key that unwraps the data key, and is
# the expensive one; DEFAULT_AUTH_KDF makes the auth key this server checks, and
# is light on purpose — it runs before `/v1/login`, so that a code is only ever
# sent to an address whose passphrase was right, and the client would otherwise
# be several seconds of key stretching away from asking for one. What that costs
# is explained in crypto.py: the scrypt over the auth key carries the difference.
#
# These MUST match the client's own defaults in src/sync/keys.ts. /v1/prelogin
# answers for unknown addresses with both blocks precisely so a stranger cannot
# tell a registered account from an unregistered one — which only holds while the
# decoy is indistinguishable from what a real registration would have stored.
# The values are what pure JS under Hermes can carry without the unlock becoming
# a wait: raise them on both sides together, never on one. The encryption key
# uses scrypt and the auth key Argon2id, which is not an oversight — see
# src/sync/keys.ts, where the difference in cost between the two in JS is
# measured and the reason for leaving the auth key alone is set out. Accounts
# made before that switch keep their own stored blocks and are unaffected; these
# two are only what a new account, and an unknown address, are answered with.
DEFAULT_KDF: dict[str, object] = {
    "algorithm": "scrypt",
    "memory_kib": 65536,
    "block_size": 8,
    "parallelism": 1,
}

DEFAULT_AUTH_KDF: dict[str, object] = {
    "algorithm": "argon2id",
    "memory_kib": 8192,
    "iterations": 1,
    "parallelism": 1,
}

# The code the tester account is always given, in every environment. It is a
# constant rather than a setting on purpose: the address it applies to is
# configuration, but what the code is should not be — a deployment cannot
# quietly turn this into a different, less obvious digit string, and anyone
# reading the environment can see exactly what it opens.
TEST_ACCOUNT_CODE = "123456"


@dataclass(frozen=True)
class Settings:
    # libpq connection string for the Postgres this server stores everything in.
    # A comment rather than a docstring: the first string in a class body becomes
    # the class's own __doc__, not the field's.
    database_url: str
    """
    Connections held open to it. One uvicorn worker serving a handful of requests
    per device per day needs very few; the ceiling is here so a burst cannot open
    more than the server's own `max_connections` allows.
    """
    pool_min_size: int
    pool_max_size: int
    """
    How long a session lasts without being used. It is a sliding window rather
    than a deadline: `/v1/session/refresh` pushes it out by another full term
    each time the device check is passed, so a phone in daily use is asked for
    both factors once and a phone that goes quiet is asked again.
    """
    token_ttl_seconds: int
    """Hard cap on an uploaded vault blob, so the box cannot be used as free storage."""
    max_ciphertext_bytes: int
    """0 means unlimited. A safety valve for a small droplet with open registration."""
    max_users: int
    max_login_attempts: int
    login_attempt_window_seconds: int
    max_registrations_per_ip: int
    registration_window_seconds: int
    """How long the emailed code works for. Short: it is six digits."""
    code_ttl_seconds: int
    """
    How long the challenge behind the code lives. Outlasts the code on purpose,
    so a user who steps away can ask for another one without going back through
    a passphrase and several seconds of Argon2id.
    """
    challenge_ttl_seconds: int
    """Wrong guesses before the challenge is destroyed and a new code is needed."""
    max_code_attempts: int
    """Codes sent per email, and per address, within `code_window_seconds`."""
    max_codes_per_email: int
    max_codes_per_ip: int
    code_window_seconds: int
    smtp_host: str
    smtp_port: int
    smtp_username: str
    smtp_password: str
    """One of "starttls", "ssl", "none"."""
    smtp_security: str
    """Envelope sender. May be a bare address or a "Name <addr>" pair."""
    email_from: str
    """Off in production: a public /docs on an auth service is an invitation to poke at it."""
    enable_docs: bool
    """
    One address whose second factor is `TEST_ACCOUNT_CODE` instead of an emailed
    code, so app testers can sign in without an inbox. Empty — the default —
    means there is no such address and every account is mailed.

    Deliberately a single address rather than a pattern or a flag: this is the
    one place the second factor is not really a second factor, and it should be
    impossible to widen it by editing an environment variable. It is set in
    development and in production alike, because a tester account that only
    works on one of them is not a tester account. See TESTER_ACCOUNT.md.
    """
    test_account_email: str


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as err:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from err


SMTP_SECURITIES = ("starttls", "ssl", "none")


def _smtp_security() -> str:
    value = os.environ.get("SMTP_SECURITY", "starttls").strip().lower() or "starttls"
    if value not in SMTP_SECURITIES:
        raise ValueError(f"SMTP_SECURITY must be one of {SMTP_SECURITIES}, got {value!r}")
    return value


def _database_url() -> str:
    url = os.environ.get(DATABASE_URL_ENV, "").strip()
    if not url:
        raise ValueError(
            f"{DATABASE_URL_ENV} is not set. It names the Postgres this server stores"
            " accounts and vaults in, e.g."
            " postgresql://authenticator:PASSWORD@postgres:5432/authenticator"
        )
    return url


def load_settings() -> Settings:
    return Settings(
        database_url=_database_url(),
        pool_min_size=_int_env("DB_POOL_MIN_SIZE", 1),
        pool_max_size=_int_env("DB_POOL_MAX_SIZE", 10),
        token_ttl_seconds=_int_env("TOKEN_TTL_SECONDS", 14 * 24 * 60 * 60),
        max_ciphertext_bytes=_int_env("MAX_CIPHERTEXT_BYTES", 1024 * 1024),
        max_users=_int_env("MAX_USERS", 0),
        max_login_attempts=_int_env("MAX_LOGIN_ATTEMPTS", 10),
        login_attempt_window_seconds=_int_env("LOGIN_ATTEMPT_WINDOW_SECONDS", 15 * 60),
        max_registrations_per_ip=_int_env("MAX_REGISTRATIONS_PER_IP", 5),
        registration_window_seconds=_int_env("REGISTRATION_WINDOW_SECONDS", 60 * 60),
        code_ttl_seconds=_int_env("CODE_TTL_SECONDS", 5 * 60),
        challenge_ttl_seconds=_int_env("CHALLENGE_TTL_SECONDS", 30 * 60),
        max_code_attempts=_int_env("MAX_CODE_ATTEMPTS", 5),
        max_codes_per_email=_int_env("MAX_CODES_PER_EMAIL", 5),
        max_codes_per_ip=_int_env("MAX_CODES_PER_IP", 20),
        code_window_seconds=_int_env("CODE_WINDOW_SECONDS", 15 * 60),
        smtp_host=os.environ.get("SMTP_HOST", "").strip(),
        smtp_port=_int_env("SMTP_PORT", 587),
        smtp_username=os.environ.get("SMTP_USERNAME", "").strip(),
        smtp_password=os.environ.get("SMTP_PASSWORD", ""),
        smtp_security=_smtp_security(),
        email_from=os.environ.get(
            "EMAIL_FROM", "Authenticator <no-reply@authenticator.moates.com.au>"
        ).strip(),
        enable_docs=os.environ.get("ENABLE_DOCS", "").strip() == "1",
        test_account_email=os.environ.get("TEST_ACCOUNT_EMAIL", "").strip().lower(),
    )
