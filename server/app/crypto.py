"""
The only cryptography the server does. It never holds a key that can open a
vault: the auth key it verifies is one half of an HKDF split, and the other half
— the one that unwraps the data key — never leaves the device.

The auth key arrives as 32 bytes of Argon2id output, so it is already
high-entropy and does not need another expensive KDF pass to resist guessing.
scrypt at modest parameters is defence in depth against a database leak, and
comes from the standard library rather than a compiled dependency.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import secrets

AUTH_KEY_BYTES = 32
TOKEN_BYTES = 32

SCRYPT_N = 2**14
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
    # maxmem has to be raised explicitly: OpenSSL's default 32MiB ceiling is
    # below what n=2**14, r=8 needs on some builds.
    return hashlib.scrypt(auth_key, salt=salt, n=n, r=r, p=p, dklen=dklen, maxmem=64 * 1024 * 1024)


def new_session_token() -> tuple[str, str]:
    """Returns (token for the client, digest to store). The token is never stored."""
    token = secrets.token_urlsafe(TOKEN_BYTES)
    return token, hash_token(token)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
