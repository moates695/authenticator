"""
Request and response bodies. Every binary field travels as standard base64 with
padding, and the server validates only length — the contents are opaque to it.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, EmailStr, Field, TypeAdapter

from .crypto import AUTH_KEY_BYTES, CODE_DIGITS, InvalidBase64, decode_b64

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


def _verification_code(value: str) -> str:
    """
    Accepts what a person actually types — spaces from a copied code, the dash
    an email client sometimes inserts on a line break — and normalises it to
    bare digits before anything compares it.
    """
    code = re.sub(r"[\s\-]", "", value)
    if not re.fullmatch(rf"\d{{{CODE_DIGITS}}}", code):
        raise ValueError(f"must be {CODE_DIGITS} digits")
    return code


VerificationCode = Annotated[str, AfterValidator(_verification_code)]
ChallengeId = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[0-9a-f]+$")]
Purpose = Literal["register", "login"]


class Argon2idParams(BaseModel):
    """Client-side Argon2id parameters. The server stores these but never runs them."""

    algorithm: Literal["argon2id"]
    memory_kib: int = Field(ge=8192, le=1024 * 1024)
    iterations: int = Field(ge=1, le=32)
    parallelism: int = Field(ge=1, le=16)


class ScryptParams(BaseModel):
    """
    Client-side scrypt parameters, and what new accounts are made with — pure-JS
    Argon2id is several times slower than pure-JS scrypt at equal memory, for
    reasons set out in src/sync/keys.ts. Also stored and never run here.

    `memory_kib` is the same quantity Argon2id states, so the two blocks stay
    comparable; the client converts it to scrypt's `N` against `block_size`.
    """

    algorithm: Literal["scrypt"]
    memory_kib: int = Field(ge=8192, le=1024 * 1024)
    block_size: int = Field(ge=1, le=64)
    parallelism: int = Field(ge=1, le=16)


# Both, because an account keeps the algorithm it was made under: the ones from
# before the switch are Argon2id and stay that way until their passphrase
# changes. The server only stores whichever block it is handed and gives it back
# at `/v1/prelogin`; deciding what to do with it is the client's problem.
KdfParams = Annotated[
    Argon2idParams | ScryptParams,
    Field(discriminator="algorithm"),
]

# A discriminated union is a type, not a class, so a stored block cannot simply
# be splatted into it the way a single model could. This is the equivalent: it
# picks the variant off `algorithm` and validates against that one.
_KDF_PARAMS = TypeAdapter(KdfParams)


def parse_kdf_params(params: Mapping[str, object]) -> Argon2idParams | ScryptParams:
    """
    Turns a stored parameter block back into its model.

    Raises `pydantic.ValidationError` on anything the client would not be able
    to derive with — including an `algorithm` this version has never heard of,
    which is worth failing on here rather than handing to a device as though it
    were usable.
    """
    return _KDF_PARAMS.validate_python(params)


class PreloginRequest(BaseModel):
    email: EmailStr


class PreloginResponse(BaseModel):
    """
    Both derivations' parameters, because a device signing in needs the light one
    before it can call `/v1/login` and the heavy one after the code comes back.
    Answered identically for an address with no account, so neither is an oracle.
    """

    kdf: KdfParams
    auth_kdf: KdfParams


class RegisterRequest(BaseModel):
    """
    Nothing but the address. The auth key and wrapped keys arrive with the code
    at `/v1/verify`, so the client can start the slow derivation after this
    request instead of before it — the Argon2id pass runs while the code is in
    transit and the user is off reading their inbox.
    """

    email: EmailStr


class LoginRequest(BaseModel):
    email: EmailStr
    auth_key: AuthKeyB64


class SessionResponse(BaseModel):
    """Returned by key rotation, which needs no key material echoed back to it."""

    user_id: str
    token: str
    expires_at: int
    vault_version: int


class SessionRefreshResponse(BaseModel):
    """
    A session pushed out by another full term. The token is not reissued: it is
    already in the device's keystore, and rotating it would mean a reply lost on
    a bad connection cost the user a passphrase and a code to recover from.
    """

    user_id: str
    expires_at: int


class ChallengeResponse(BaseModel):
    """
    What register and login return now. Neither issues a session: the passphrase
    is the first factor and a code sent to the address on file is the second, so
    the token comes from `/v1/verify` and nowhere else.
    """

    challenge_id: str
    email: EmailStr
    purpose: Purpose
    """When the digits in the inbox stop working."""
    code_expires_at: int
    """When the challenge itself is gone and the passphrase has to be typed again."""
    expires_at: int


class VerifyRequest(BaseModel):
    """
    The material fields belong to registrations, which have no account row until
    this request lands: the right code plus what the account is made of, in one
    step. A sign-in's challenge ignores them.
    """

    challenge_id: ChallengeId
    code: VerificationCode
    auth_key: AuthKeyB64 | None = None
    kdf: KdfParams | None = None
    auth_kdf: KdfParams | None = None
    wrapped_passphrase: WrappedKeyB64 | None = None
    wrapped_recovery: WrappedKeyB64 | None = None


class ResendRequest(BaseModel):
    challenge_id: ChallengeId


class LoginResponse(BaseModel):
    """
    The answer to a verified challenge, for a registration as much as a sign-in.
    A device that has just registered already holds these, but one shape for the
    one endpoint that issues sessions is worth more than the bytes it saves.
    """

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
    auth_kdf: KdfParams
    wrapped_passphrase: WrappedKeyB64
    wrapped_recovery: WrappedKeyB64


class AccountDeleteRequest(BaseModel):
    auth_key: AuthKeyB64
