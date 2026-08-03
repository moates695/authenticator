"""
The sync server. It moves one opaque blob per account and does nothing else.

What it stores: an email, a digest of the auth key, the client's KDF parameters,
two wrapped copies of the data key, and the encrypted vault. What it can do with
all of that: nothing. Unwrapping the data key needs the encryption key, which is
the other half of an HKDF split that never leaves the device.

Conflicts are handled with a version counter rather than merging: a PUT states
the version it is replacing, and a mismatch comes back as 409 with the current
state so the client can merge locally and try again.
"""

import json
import sqlite3
import time
import uuid
from dataclasses import dataclass
from typing import Annotated, Iterator

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response, status

from . import crypto
from .config import DEFAULT_KDF, Settings, load_settings
from .db import connect, init_db
from .schemas import (
    AccountDeleteRequest,
    KdfParams,
    KeysPutRequest,
    LoginRequest,
    LoginResponse,
    PreloginRequest,
    PreloginResponse,
    RegisterRequest,
    SessionResponse,
    VaultPutRequest,
    VaultPutResponse,
    VaultResponse,
)

API_PREFIX = "/v1"

# Verified against when an email is unknown, so a missing account costs the same
# time as a wrong auth key and cannot be distinguished by timing.
DUMMY_AUTH_KEY_HASH = crypto.hash_auth_key(b"\x00" * crypto.AUTH_KEY_BYTES)

# Throttle event kinds.
LOGIN_FAILURE = "login_failure"
REGISTRATION = "registration"

# Throttle rows are useless once they fall outside every window; a day covers the
# longest one with room to spare.
THROTTLE_RETENTION_SECONDS = 24 * 60 * 60


@dataclass(frozen=True)
class Session:
    user_id: str
    token_hash: str


def normalise_email(email: str) -> str:
    return email.strip().lower()


def client_ip(request: Request) -> str:
    """
    nginx sets X-Real-IP to the client recovered from CF-Connecting-IP, so this is
    the visitor rather than the Cloudflare edge. Falls back to the socket peer for
    local runs where there is no proxy in front.
    """
    header = request.headers.get("x-real-ip")
    if header:
        return header.strip()
    return request.client.host if request.client else "unknown"


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    init_db(settings.db_path)

    docs_url = "/docs" if settings.enable_docs else None
    app = FastAPI(
        title="Authenticator sync",
        version="0.1.0",
        docs_url=docs_url,
        redoc_url=None,
        openapi_url="/openapi.json" if settings.enable_docs else None,
    )

    def get_db() -> Iterator[sqlite3.Connection]:
        connection = connect(settings.db_path)
        try:
            yield connection
        finally:
            connection.close()

    Db = Annotated[sqlite3.Connection, Depends(get_db)]

    def current_session(
        db: Db,
        authorization: Annotated[str | None, Header()] = None,
    ) -> Session:
        if not authorization or not authorization.lower().startswith("bearer "):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing bearer token")

        token_hash = crypto.hash_token(authorization[len("bearer ") :].strip())
        row = db.execute(
            "SELECT user_id, expires_at FROM sessions WHERE token_hash = ?", (token_hash,)
        ).fetchone()
        if row is None or row["expires_at"] <= int(time.time()):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired")

        return Session(user_id=row["user_id"], token_hash=token_hash)

    CurrentSession = Annotated[Session, Depends(current_session)]

    # --- helpers -----------------------------------------------------------

    def prune(db: sqlite3.Connection, now: int) -> None:
        db.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
        db.execute(
            "DELETE FROM throttle_events WHERE at < ?", (now - THROTTLE_RETENTION_SECONDS,)
        )

    def count_events(db: sqlite3.Connection, kind: str, key: str, since: int) -> int:
        row = db.execute(
            "SELECT COUNT(*) AS n FROM throttle_events WHERE kind = ? AND key = ? AND at >= ?",
            (kind, key, since),
        ).fetchone()
        return int(row["n"])

    def record_event(db: sqlite3.Connection, kind: str, key: str, now: int) -> None:
        db.execute(
            "INSERT INTO throttle_events (kind, key, at) VALUES (?, ?, ?)", (kind, key, now)
        )

    def issue_session(db: sqlite3.Connection, user_id: str, now: int) -> tuple[str, int]:
        token, token_hash = crypto.new_session_token()
        expires_at = now + settings.token_ttl_seconds
        db.execute(
            "INSERT INTO sessions (token_hash, user_id, created_at, expires_at)"
            " VALUES (?, ?, ?, ?)",
            (token_hash, user_id, now, expires_at),
        )
        return token, expires_at

    def vault_version(db: sqlite3.Connection, user_id: str) -> int:
        row = db.execute("SELECT version FROM vaults WHERE user_id = ?", (user_id,)).fetchone()
        return int(row["version"]) if row else 0

    # --- endpoints ---------------------------------------------------------

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post(f"{API_PREFIX}/prelogin", response_model=PreloginResponse)
    def prelogin(body: PreloginRequest, db: Db) -> PreloginResponse:
        """
        A device that has never seen this account needs the KDF parameters before
        it can derive an auth key. Unknown emails get the current defaults rather
        than a 404, so this cannot be used to enumerate accounts.
        """
        row = db.execute(
            "SELECT kdf_params FROM users WHERE email = ?", (normalise_email(body.email),)
        ).fetchone()
        params = json.loads(row["kdf_params"]) if row else DEFAULT_KDF
        return PreloginResponse(kdf=KdfParams(**params))

    @app.post(
        f"{API_PREFIX}/register",
        response_model=SessionResponse,
        status_code=status.HTTP_201_CREATED,
    )
    def register(body: RegisterRequest, request: Request, db: Db) -> SessionResponse:
        now = int(time.time())
        email = normalise_email(body.email)
        ip = client_ip(request)

        prune(db, now)

        window_start = now - settings.registration_window_seconds
        if count_events(db, REGISTRATION, ip, window_start) >= settings.max_registrations_per_ip:
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "Too many accounts created from this address. Try again later.",
                headers={"Retry-After": str(settings.registration_window_seconds)},
            )

        if settings.max_users:
            total = db.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
            if int(total) >= settings.max_users:
                raise HTTPException(
                    status.HTTP_503_SERVICE_UNAVAILABLE, "This server is not accepting new accounts."
                )

        # Recorded before the insert so failed attempts count too, otherwise the
        # throttle can be sidestepped by hammering an email that already exists.
        record_event(db, REGISTRATION, ip, now)

        user_id = uuid.uuid4().hex
        db.execute("BEGIN IMMEDIATE")
        try:
            db.execute(
                "INSERT INTO users (id, email, auth_key_hash, kdf_params, wrapped_passphrase,"
                " wrapped_recovery, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    user_id,
                    email,
                    crypto.hash_auth_key(crypto.decode_b64(body.auth_key)),
                    body.kdf.model_dump_json(),
                    body.wrapped_passphrase,
                    body.wrapped_recovery,
                    now,
                    now,
                ),
            )
            db.execute(
                "INSERT INTO vaults (user_id, version, ciphertext, updated_at)"
                " VALUES (?, 0, NULL, ?)",
                (user_id, now),
            )
            token, expires_at = issue_session(db, user_id, now)
            db.execute("COMMIT")
        except sqlite3.IntegrityError as err:
            db.execute("ROLLBACK")
            raise HTTPException(
                status.HTTP_409_CONFLICT, "That email address is already registered."
            ) from err
        except Exception:
            db.execute("ROLLBACK")
            raise

        return SessionResponse(
            user_id=user_id, token=token, expires_at=expires_at, vault_version=0
        )

    @app.post(f"{API_PREFIX}/login", response_model=LoginResponse)
    def login(body: LoginRequest, request: Request, db: Db) -> LoginResponse:
        now = int(time.time())
        email = normalise_email(body.email)
        throttle_key = f"{email}|{client_ip(request)}"

        prune(db, now)

        window_start = now - settings.login_attempt_window_seconds
        if count_events(db, LOGIN_FAILURE, throttle_key, window_start) >= settings.max_login_attempts:
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "Too many failed attempts. Try again later.",
                headers={"Retry-After": str(settings.login_attempt_window_seconds)},
            )

        row = db.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        stored_hash = row["auth_key_hash"] if row else DUMMY_AUTH_KEY_HASH
        if not crypto.verify_auth_key(crypto.decode_b64(body.auth_key), stored_hash) or row is None:
            record_event(db, LOGIN_FAILURE, throttle_key, now)
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED, "Email address or passphrase is incorrect."
            )

        db.execute(
            "DELETE FROM throttle_events WHERE kind = ? AND key = ?",
            (LOGIN_FAILURE, throttle_key),
        )
        token, expires_at = issue_session(db, row["id"], now)

        return LoginResponse(
            user_id=row["id"],
            token=token,
            expires_at=expires_at,
            kdf=KdfParams(**json.loads(row["kdf_params"])),
            wrapped_passphrase=row["wrapped_passphrase"],
            wrapped_recovery=row["wrapped_recovery"],
            vault_version=vault_version(db, row["id"]),
        )

    @app.post(f"{API_PREFIX}/logout", status_code=status.HTTP_204_NO_CONTENT)
    def logout(session: CurrentSession, db: Db) -> Response:
        db.execute("DELETE FROM sessions WHERE token_hash = ?", (session.token_hash,))
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @app.get(f"{API_PREFIX}/vault", response_model=VaultResponse)
    def get_vault(session: CurrentSession, db: Db) -> VaultResponse:
        row = db.execute(
            "SELECT version, ciphertext, updated_at FROM vaults WHERE user_id = ?",
            (session.user_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No vault for this account")

        blob = row["ciphertext"]
        return VaultResponse(
            version=int(row["version"]),
            ciphertext=crypto.encode_b64(blob) if blob is not None else None,
            updated_at=int(row["updated_at"]),
        )

    @app.put(f"{API_PREFIX}/vault", response_model=VaultPutResponse)
    def put_vault(body: VaultPutRequest, session: CurrentSession, db: Db) -> VaultPutResponse:
        blob = crypto.decode_b64(body.ciphertext)
        if len(blob) > settings.max_ciphertext_bytes:
            raise HTTPException(
                status.HTTP_413_CONTENT_TOO_LARGE,
                f"Vault is larger than the {settings.max_ciphertext_bytes} byte limit.",
            )

        now = int(time.time())
        db.execute("BEGIN IMMEDIATE")
        try:
            row = db.execute(
                "SELECT version, ciphertext, updated_at FROM vaults WHERE user_id = ?",
                (session.user_id,),
            ).fetchone()
            if row is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "No vault for this account")

            current_version = int(row["version"])
            if current_version != body.base_version:
                # The client merges and retries; hand it everything it needs so
                # that takes one round trip rather than a pull followed by a push.
                current = row["ciphertext"]
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {
                        "reason": "version_mismatch",
                        "version": current_version,
                        "ciphertext": crypto.encode_b64(current) if current is not None else None,
                        "updated_at": int(row["updated_at"]),
                    },
                )

            next_version = current_version + 1
            db.execute(
                "UPDATE vaults SET version = ?, ciphertext = ?, updated_at = ? WHERE user_id = ?",
                (next_version, blob, now, session.user_id),
            )
            db.execute("COMMIT")
        except BaseException:
            db.execute("ROLLBACK")
            raise

        return VaultPutResponse(version=next_version, updated_at=now)

    @app.put(f"{API_PREFIX}/keys", response_model=SessionResponse)
    def put_keys(body: KeysPutRequest, session: CurrentSession, db: Db) -> SessionResponse:
        """
        Re-wraps the data key under a new passphrase or a new recovery key. The
        vault ciphertext is untouched: only the 32-byte data key was ever wrapped,
        which is the whole point of the indirection.
        """
        now = int(time.time())
        row = db.execute(
            "SELECT auth_key_hash FROM users WHERE id = ?", (session.user_id,)
        ).fetchone()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No such account")

        if not crypto.verify_auth_key(crypto.decode_b64(body.current_auth_key), row["auth_key_hash"]):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Current passphrase is incorrect.")

        db.execute("BEGIN IMMEDIATE")
        try:
            db.execute(
                "UPDATE users SET auth_key_hash = ?, kdf_params = ?, wrapped_passphrase = ?,"
                " wrapped_recovery = ?, updated_at = ? WHERE id = ?",
                (
                    crypto.hash_auth_key(crypto.decode_b64(body.new_auth_key)),
                    body.kdf.model_dump_json(),
                    body.wrapped_passphrase,
                    body.wrapped_recovery,
                    now,
                    session.user_id,
                ),
            )
            # Every existing session was authorised under the old passphrase.
            db.execute("DELETE FROM sessions WHERE user_id = ?", (session.user_id,))
            token, expires_at = issue_session(db, session.user_id, now)
            db.execute("COMMIT")
        except BaseException:
            db.execute("ROLLBACK")
            raise

        return SessionResponse(
            user_id=session.user_id,
            token=token,
            expires_at=expires_at,
            vault_version=vault_version(db, session.user_id),
        )

    @app.post(f"{API_PREFIX}/account/delete", status_code=status.HTTP_204_NO_CONTENT)
    def delete_account(body: AccountDeleteRequest, session: CurrentSession, db: Db) -> Response:
        """Requires the auth key as well as a session, since it is irreversible."""
        row = db.execute(
            "SELECT auth_key_hash FROM users WHERE id = ?", (session.user_id,)
        ).fetchone()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No such account")
        if not crypto.verify_auth_key(crypto.decode_b64(body.auth_key), row["auth_key_hash"]):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Passphrase is incorrect.")

        # Vault and sessions go with it via ON DELETE CASCADE.
        db.execute("DELETE FROM users WHERE id = ?", (session.user_id,))
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return app
