"""
Request and response bodies. Every binary field travels as standard base64 with
padding, and the server validates only length — the contents are opaque to it.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, EmailStr, Field

from .crypto import AUTH_KEY_BYTES, InvalidBase64, decode_b64

# A wrapped 32-byte data key is a version byte, a 24-byte nonce, 32 bytes of
# ciphertext and a 16-byte tag. The cap leaves room for the format to change
# without letting the field become a general-purpose storage channel.
MAX_WRAPPED_KEY_BYTES = 512


def _decoded_length(value: str, *, exact: int | None = None, maximum: int | None = None) -> str:
    try:
        raw = decode_b64(value)
    except InvalidBase64 as err:
        raise ValueError(f"not valid base64: {err}") from err
    if exact is not None and len(raw) != exact:
        raise ValueError(f"must decode to exactly {exact} bytes, got {len(raw)}")
    if maximum is not None and len(raw) > maximum:
        raise ValueError(f"must decode to at most {maximum} bytes, got {len(raw)}")
    return value


AuthKeyB64 = Annotated[str, AfterValidator(lambda v: _decoded_length(v, exact=AUTH_KEY_BYTES))]
WrappedKeyB64 = Annotated[
    str, AfterValidator(lambda v: _decoded_length(v, maximum=MAX_WRAPPED_KEY_BYTES))
]
# The ciphertext cap is a setting rather than a schema rule, so it is enforced in
# the endpoint where it can return 413 instead of a validation error.
CiphertextB64 = Annotated[str, AfterValidator(lambda v: _decoded_length(v))]


class KdfParams(BaseModel):
    """Client-side Argon2id parameters. The server stores these but never runs them."""

    algorithm: Literal["argon2id"]
    memory_kib: int = Field(ge=8192, le=1024 * 1024)
    iterations: int = Field(ge=1, le=32)
    parallelism: int = Field(ge=1, le=16)


class PreloginRequest(BaseModel):
    email: EmailStr


class PreloginResponse(BaseModel):
    kdf: KdfParams


class RegisterRequest(BaseModel):
    email: EmailStr
    auth_key: AuthKeyB64
    kdf: KdfParams
    wrapped_passphrase: WrappedKeyB64
    wrapped_recovery: WrappedKeyB64


class LoginRequest(BaseModel):
    email: EmailStr
    auth_key: AuthKeyB64


class SessionResponse(BaseModel):
    """Returned by register, which needs no key material echoed back to it."""

    user_id: str
    token: str
    expires_at: int
    vault_version: int


class LoginResponse(BaseModel):
    user_id: str
    token: str
    expires_at: int
    kdf: KdfParams
    wrapped_passphrase: WrappedKeyB64
    wrapped_recovery: WrappedKeyB64
    vault_version: int


class VaultResponse(BaseModel):
    version: int
    """None until the device has pushed for the first time."""
    ciphertext: CiphertextB64 | None
    updated_at: int


class VaultPutRequest(BaseModel):
    """`base_version` is the version this device last saw, for optimistic concurrency."""

    base_version: int = Field(ge=0)
    ciphertext: CiphertextB64


class VaultPutResponse(BaseModel):
    version: int
    updated_at: int


class KeysPutRequest(BaseModel):
    """
    Passphrase change or recovery key rotation. The current auth key is required
    as well as a live session, so a stolen token alone cannot lock the owner out.
    """

    current_auth_key: AuthKeyB64
    new_auth_key: AuthKeyB64
    kdf: KdfParams
    wrapped_passphrase: WrappedKeyB64
    wrapped_recovery: WrappedKeyB64


class AccountDeleteRequest(BaseModel):
    auth_key: AuthKeyB64
