"""
Runtime configuration. Everything is overridable by environment variable so the
container can be retuned without a rebuild; the defaults are what production
runs with.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_DB_PATH = "/data/authenticator.db"

# Client-side Argon2id parameters handed to a device that has never seen a given
# account. Each account stores its own copy at registration, so raising these
# later affects new accounts immediately and existing ones only when they next
# change their passphrase.
DEFAULT_KDF: dict[str, object] = {
    "algorithm": "argon2id",
    "memory_kib": 65536,
    "iterations": 3,
    "parallelism": 1,
}


@dataclass(frozen=True)
class Settings:
    db_path: Path
    """Session tokens are short-lived; devices re-login silently with a stored auth key."""
    token_ttl_seconds: int
    """Hard cap on an uploaded vault blob, so the box cannot be used as free storage."""
    max_ciphertext_bytes: int
    """0 means unlimited. A safety valve for a small droplet with open registration."""
    max_users: int
    max_login_attempts: int
    login_attempt_window_seconds: int
    max_registrations_per_ip: int
    registration_window_seconds: int
    """Off in production: a public /docs on an auth service is an invitation to poke at it."""
    enable_docs: bool


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as err:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from err


def load_settings() -> Settings:
    return Settings(
        db_path=Path(os.environ.get("DB_PATH", DEFAULT_DB_PATH)),
        token_ttl_seconds=_int_env("TOKEN_TTL_SECONDS", 24 * 60 * 60),
        max_ciphertext_bytes=_int_env("MAX_CIPHERTEXT_BYTES", 1024 * 1024),
        max_users=_int_env("MAX_USERS", 0),
        max_login_attempts=_int_env("MAX_LOGIN_ATTEMPTS", 10),
        login_attempt_window_seconds=_int_env("LOGIN_ATTEMPT_WINDOW_SECONDS", 15 * 60),
        max_registrations_per_ip=_int_env("MAX_REGISTRATIONS_PER_IP", 5),
        registration_window_seconds=_int_env("REGISTRATION_WINDOW_SECONDS", 60 * 60),
        enable_docs=os.environ.get("ENABLE_DOCS", "").strip() == "1",
    )
