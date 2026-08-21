"""
The only cryptography the server does. It never holds a key that can open a
vault: the auth key it verifies comes from its own derivation, and the one that
unwraps the data key never leaves the device.

The auth key arrives as 32 bytes of Argon2id output, but from a deliberately
light pass — the client runs it before `/v1/login` so a code is only sent once
the passphrase is known to be right, and the heavy pass that produces the
encryption key happens after the code comes back. That makes the scrypt below
most of what a passphrase guess costs an attacker holding this database, rather
than a second lock behind an already expensive one, which is why its parameters
are set well above where defence in depth would have left them.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import secrets

AUTH_KEY_BYTES = 32
TOKEN_BYTES = 32

# Six digits is what people will retype off a phone screen without resenting it.
# A million possibilities is not much on its own, which is why the code is only
# ever the second factor, lives fifteen minutes, and dies after a few wrong guesses.
CODE_DIGITS = 6

# 64MiB and a couple of hundred milliseconds per verification. The digest is
# self-describing, so raising these again later leaves existing hashes verifying
# on the parameters they were made with.
SCRYPT_N = 2**16
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_SALT_BYTES = 16
SCRYPT_DK_BYTES = 32


class InvalidBase64(ValueError):
    """Raised when a base64 field cannot be decoded."""


def decode_b64(value: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as err:
        raise InvalidBase64(str(err)) from err


def encode_b64(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def hash_auth_key(auth_key: bytes) -> str:
    """Returns a self-describing digest, so parameters can be raised later."""
    salt = secrets.token_bytes(SCRYPT_SALT_BYTES)
    digest = _scrypt(auth_key, salt)
    return "$".join(
        [
            "scrypt",
            str(SCRYPT_N),
            str(SCRYPT_R),
            str(SCRYPT_P),
            encode_b64(salt),
            encode_b64(digest),
        ]
    )


def verify_auth_key(auth_key: bytes, encoded: str) -> bool:
    try:
        scheme, n, r, p, salt_b64, digest_b64 = encoded.split("$")
        if scheme != "scrypt":
            return False
        salt = decode_b64(salt_b64)
        expected = decode_b64(digest_b64)
        actual = _scrypt(auth_key, salt, n=int(n), r=int(r), p=int(p), dklen=len(expected))
    except (ValueError, InvalidBase64):
        return False
    return hmac.compare_digest(actual, expected)


def _scrypt(
    auth_key: bytes,
    salt: bytes,
    *,
    n: int = SCRYPT_N,
    r: int = SCRYPT_R,
    p: int = SCRYPT_P,
    dklen: int = SCRYPT_DK_BYTES,
) -> bytes:
    # maxmem has to be raised explicitly: OpenSSL's default 32MiB ceiling is far
    # below the 128 * n * r bytes n=2**16, r=8 needs. Sized for the parameters a
    # stored digest may name rather than for the current ones, so verifying an
    # old hash cannot fail on a limit set for a newer one.
    return hashlib.scrypt(
        auth_key, salt=salt, n=n, r=r, p=p, dklen=dklen, maxmem=256 * 1024 * 1024
    )


def new_session_token() -> tuple[str, str]:
    """Returns (token for the client, digest to store). The token is never stored."""
    token = secrets.token_urlsafe(TOKEN_BYTES)
    return token, hash_token(token)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_verification_code() -> str:
    """Uniform over every six-digit string, leading zeros included."""
    return f"{secrets.randbelow(10**CODE_DIGITS):0{CODE_DIGITS}d}"


def hash_code(code: str) -> str:
    """
    A plain digest, not scrypt. Six digits fall to a dictionary of a million
    entries whatever the parameters, so this is not what stops an attacker who
    has the database — the attempt cap and the fifteen minute life are. What it
    does buy is that a backup, a log line or a stray query result does not hand
    over a live code in the clear.
    """
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


def code_matches(code: str, encoded: str) -> bool:
    return hmac.compare_digest(hash_code(code), encoded)
