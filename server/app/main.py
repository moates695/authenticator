"""
The sync server. It moves one opaque blob per account and does nothing else.

What it stores: an email, a digest of the auth key, the client's KDF parameters,
two wrapped copies of the data key, and the encrypted vault. What it can do with
all of that: nothing. Unwrapping the data key needs the encryption key, which
comes from a derivation whose output never leaves the device.

Getting a session takes two factors. The passphrase proves itself through the
auth key; a six-digit code sent to the address on the account proves the address.
Neither `/v1/register` nor `/v1/login` hands back a token — both return a
challenge, and `/v1/verify` is the only endpoint that issues one. An account
whose address has never answered a code cannot hold a session — indeed cannot
exist: `/v1/register` takes nothing but the address and sends the code, and the
account is created at `/v1/verify`, where the code and the key material arrive
together. The client runs its deliberately slow key derivation between the two,
while the code is making its way through the user's inbox.

A sign-in orders the same three things differently, because a code must not go
out to an address whose passphrase was wrong. `/v1/login` therefore still wants
the auth key up front — but the auth key has a light derivation of its own, so
that costs a moment rather than the several seconds the encryption key takes.
That heavy derivation happens after `/v1/verify` has accepted the code, on the
client, and this server never learns whether it succeeded.

A session then slides rather than expiring on a fixed date: the device renews it
through `/v1/session/refresh` whenever its owner passes the phone's own unlock
check. Both factors are for adopting a device, not for using one.

Conflicts are handled with a version counter rather than merging: a PUT states
the version it is replacing, and a mismatch comes back as 409 with the current
state so the client can merge locally and try again.
"""

import json
import logging
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Annotated, Any, AsyncIterator, Iterator

import psycopg
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response, status
from psycopg.errors import UniqueViolation

from . import crypto, mail
from .config import DEFAULT_AUTH_KDF, DEFAULT_KDF, Settings, load_settings
from .db import build_pool, init_db
from .schemas import (
    AccountDeleteRequest,
    ChallengeResponse,
    KdfParams,
    KeysPutRequest,
    LoginRequest,
    LoginResponse,
    PreloginRequest,
    PreloginResponse,
    RegisterRequest,
    ResendRequest,
    SessionRefreshResponse,
    SessionResponse,
    VaultPutRequest,
    VaultPutResponse,
    VaultResponse,
    VerifyRequest,
)

API_PREFIX = "/v1"

log = logging.getLogger("authenticator")

# Verified against when an email is unknown, so a missing account costs the same
# time as a wrong auth key and cannot be distinguished by timing.
DUMMY_AUTH_KEY_HASH = crypto.hash_auth_key(b"\x00" * crypto.AUTH_KEY_BYTES)

# Throttle event kinds.
LOGIN_FAILURE = "login_failure"
REGISTRATION = "registration"
CODE_SEND = "code_send"

# What a challenge is for. Registration confirms an address for the first time;
# a sign-in re-proves it as the second factor.
REGISTER = "register"
LOGIN = "login"

# The two tables a code can live in. Interpolated into SQL by `check_code`,
# which only ever receives these constants, never caller input.
EMAIL_CHALLENGES = "email_challenges"
PENDING_REGISTRATIONS = "pending_registrations"

# Throttle rows are useless once they fall outside every window; a day covers the
# longest one with room to spare.
THROTTLE_RETENTION_SECONDS = 24 * 60 * 60


@dataclass(frozen=True)
class Session:
    user_id: str
    token_hash: str


# A row as psycopg hands it back under `dict_row`. Named for what the queries
# below expect of it: subscripting by column, and `None` for a miss.
Row = dict[str, Any]


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


def create_app(settings: Settings | None = None, mailer: mail.Mailer | None = None) -> FastAPI:
    settings = settings or load_settings()
    # Built at startup rather than per request, so a server with no way to send
    # a code fails to boot instead of failing at the first registration.
    mailer = mailer or mail.build_mailer(settings)
    init_db(settings.database_url)

    # Opened here rather than in the lifespan handler because a TestClient used
    # without its context manager never runs one, and the app is expected to work
    # the moment it is built. `wait` means a bad address is a startup failure.
    pool = build_pool(settings.database_url, settings.pool_min_size, settings.pool_max_size)
    pool.open(wait=True, timeout=30)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        try:
            yield
        finally:
            pool.close()

    docs_url = "/docs" if settings.enable_docs else None
    app = FastAPI(
        title="Authenticator sync",
        version="0.1.0",
        docs_url=docs_url,
        redoc_url=None,
        openapi_url="/openapi.json" if settings.enable_docs else None,
        lifespan=lifespan,
    )
    # So a caller that built the app itself — a test, a script — can hand the
    # connections back without waiting for a shutdown event it never triggers.
    app.state.db_pool = pool

    def get_db() -> Iterator[psycopg.Connection]:
        with pool.connection() as connection:
            yield connection

    Db = Annotated[psycopg.Connection, Depends(get_db)]

    def current_session(
        db: Db,
        authorization: Annotated[str | None, Header()] = None,
    ) -> Session:
        if not authorization or not authorization.lower().startswith("bearer "):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing bearer token")

        token_hash = crypto.hash_token(authorization[len("bearer ") :].strip())
        row = db.execute(
            "SELECT sessions.user_id AS user_id, sessions.expires_at AS expires_at,"
            " users.verified_at AS verified_at FROM sessions"
            " JOIN users ON users.id = sessions.user_id WHERE token_hash = %s",
            (token_hash,),
        ).fetchone()
        if row is None or row["expires_at"] <= int(time.time()):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired")

        # No path issues a token to an unverified account, so this should be
        # unreachable. It is checked anyway because it is the invariant the
        # whole flow exists to hold: no verified address, no account.
        if row["verified_at"] is None:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "This account's email address is not verified."
            )

        return Session(user_id=row["user_id"], token_hash=token_hash)

    CurrentSession = Annotated[Session, Depends(current_session)]

    # --- helpers -----------------------------------------------------------

    def prune(db: psycopg.Connection, now: int) -> None:
        db.execute("DELETE FROM sessions WHERE expires_at <= %s", (now,))
        db.execute("DELETE FROM email_challenges WHERE expires_at <= %s", (now,))
        db.execute("DELETE FROM pending_registrations WHERE expires_at <= %s", (now,))
        db.execute(
            "DELETE FROM throttle_events WHERE at < %s", (now - THROTTLE_RETENTION_SECONDS,)
        )

    def count_events(db: psycopg.Connection, kind: str, key: str, since: int) -> int:
        row = db.execute(
            "SELECT COUNT(*) AS n FROM throttle_events WHERE kind = %s AND key = %s AND at >= %s",
            (kind, key, since),
        ).fetchone()
        return int(row["n"])

    def record_event(db: psycopg.Connection, kind: str, key: str, now: int) -> None:
        db.execute(
            "INSERT INTO throttle_events (kind, key, at) VALUES (%s, %s, %s)", (kind, key, now)
        )

    def issue_session(db: psycopg.Connection, user_id: str, now: int) -> tuple[str, int]:
        token, token_hash = crypto.new_session_token()
        expires_at = now + settings.token_ttl_seconds
        db.execute(
            "INSERT INTO sessions (token_hash, user_id, created_at, expires_at)"
            " VALUES (%s, %s, %s, %s)",
            (token_hash, user_id, now, expires_at),
        )
        return token, expires_at

    def vault_version(db: psycopg.Connection, user_id: str) -> int:
        row = db.execute("SELECT version FROM vaults WHERE user_id = %s", (user_id,)).fetchone()
        return int(row["version"]) if row else 0

    # --- the second factor -------------------------------------------------

    def check_send_throttle(db: psycopg.Connection, email: str, ip: str, now: int) -> None:
        """
        Every code costs a message to somebody's inbox, so the limit is on the
        address as much as on the sender: without the first, anyone could use
        this to post a few hundred emails to an address they do not own.
        """
        window_start = now - settings.code_window_seconds
        limits = (
            (f"email:{email}", settings.max_codes_per_email),
            (f"ip:{ip}", settings.max_codes_per_ip),
        )
        for key, limit in limits:
            if count_events(db, CODE_SEND, key, window_start) >= limit:
                raise HTTPException(
                    status.HTTP_429_TOO_MANY_REQUESTS,
                    "Too many codes requested. Try again later.",
                    headers={"Retry-After": str(settings.code_window_seconds)},
                )

    def deliver(email: str, code: str, purpose: str) -> None:
        try:
            mailer.send(
                mail.verification_message(email, code, purpose, settings.code_ttl_seconds)
            )
        except mail.SendFailed as err:
            # Logged in full, reported vaguely: a bounce message names the
            # mailbox, and this endpoint answers strangers.
            log.error("Could not send a verification code: %s", err)
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "The code could not be sent. Try again in a moment.",
            ) from err

    def start_challenge(
        db: psycopg.Connection,
        request: Request,
        user_id: str,
        email: str,
        purpose: str,
        now: int,
        deadline: int | None = None,
    ) -> ChallengeResponse:
        """
        Issues a code and destroys whatever was outstanding for the account. One
        live code per address, at all times, is what makes "single use" mean
        anything: without it a stack of old codes would each stay usable until
        they aged out.

        `deadline` carries the original challenge expiry through a resend, so
        asking for another code cannot stretch the flow past the half hour it
        started with.
        """
        check_send_throttle(db, email, client_ip(request), now)

        code = crypto.new_verification_code()
        challenge_id = uuid.uuid4().hex
        expires_at = deadline or now + settings.challenge_ttl_seconds
        # A code handed out near the end of a challenge dies with it rather than
        # appearing to have longer left than it does.
        code_expires_at = min(now + settings.code_ttl_seconds, expires_at)

        db.execute("DELETE FROM email_challenges WHERE user_id = %s", (user_id,))
        db.execute(
            "INSERT INTO email_challenges (id, user_id, purpose, code_hash, attempts,"
            " created_at, code_expires_at, expires_at) VALUES (%s, %s, %s, %s, 0, %s, %s, %s)",
            (
                challenge_id,
                user_id,
                purpose,
                crypto.hash_code(code),
                now,
                code_expires_at,
                expires_at,
            ),
        )
        # Counted before the send, so a provider having a bad day cannot be used
        # to hammer an address for free.
        record_event(db, CODE_SEND, f"email:{email}", now)
        record_event(db, CODE_SEND, f"ip:{client_ip(request)}", now)

        try:
            deliver(email, code, purpose)
        except HTTPException:
            # Nothing arrived, so leaving a live challenge behind would only
            # give the client something useless to type into.
            db.execute("DELETE FROM email_challenges WHERE id = %s", (challenge_id,))
            raise

        return ChallengeResponse(
            challenge_id=challenge_id,
            email=email,
            purpose=purpose,
            code_expires_at=code_expires_at,
            expires_at=expires_at,
        )

    def start_registration(
        db: psycopg.Connection,
        request: Request,
        email: str,
        now: int,
        deadline: int | None = None,
    ) -> ChallengeResponse:
        """
        `start_challenge`'s twin for an account that does not exist yet. The row
        lives in `pending_registrations` rather than against a user: nothing
        about the address is proved and no key material has been given, so there
        is nothing to make an account of until `/v1/verify` brings both. One row
        per address, for the same reason `start_challenge` keeps one live code
        per account.
        """
        check_send_throttle(db, email, client_ip(request), now)

        code = crypto.new_verification_code()
        challenge_id = uuid.uuid4().hex
        expires_at = deadline or now + settings.challenge_ttl_seconds
        code_expires_at = min(now + settings.code_ttl_seconds, expires_at)

        db.execute("DELETE FROM pending_registrations WHERE email = %s", (email,))
        db.execute(
            "INSERT INTO pending_registrations (id, email, code_hash, attempts,"
            " created_at, code_expires_at, expires_at) VALUES (%s, %s, %s, 0, %s, %s, %s)",
            (challenge_id, email, crypto.hash_code(code), now, code_expires_at, expires_at),
        )
        record_event(db, CODE_SEND, f"email:{email}", now)
        record_event(db, CODE_SEND, f"ip:{client_ip(request)}", now)

        try:
            deliver(email, code, REGISTER)
        except HTTPException:
            db.execute("DELETE FROM pending_registrations WHERE id = %s", (challenge_id,))
            raise

        return ChallengeResponse(
            challenge_id=challenge_id,
            email=email,
            purpose=REGISTER,
            code_expires_at=code_expires_at,
            expires_at=expires_at,
        )

    def check_code(db: psycopg.Connection, table: str, row: Row, code: str, now: int) -> None:
        """
        The code lifecycle both kinds of challenge share: expiry, the attempt
        budget, and destruction once the guesses run out. Raises unless the code
        is current and right; the row survives a wrong guess so the client can
        ask for a fresh code instead of starting over.
        """
        # The row stays: the digits are dead but the challenge behind them is
        # not, and that is what lets the client ask for another code instead of
        # sending the user back to the passphrase.
        if row["code_expires_at"] <= now:
            raise HTTPException(
                status.HTTP_410_GONE, "That code has expired. Ask for a new one."
            )

        if crypto.code_matches(code, row["code_hash"]):
            return

        attempts = int(row["attempts"]) + 1
        if attempts >= settings.max_code_attempts:
            db.execute(f"DELETE FROM {table} WHERE id = %s", (row["id"],))
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "Too many incorrect codes. Ask for a new one.",
            )
        db.execute(f"UPDATE {table} SET attempts = %s WHERE id = %s", (attempts, row["id"]))
        remaining = settings.max_code_attempts - attempts
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            f"That code is not right. {remaining} {'try' if remaining == 1 else 'tries'} left.",
        )

    def session_response(
        db: psycopg.Connection, user_id: str, token: str, expires_at: int
    ) -> LoginResponse:
        user = db.execute("SELECT * FROM users WHERE id = %s", (user_id,)).fetchone()
        return LoginResponse(
            user_id=user_id,
            token=token,
            expires_at=expires_at,
            kdf=KdfParams(**json.loads(user["kdf_params"])),
            wrapped_passphrase=user["wrapped_passphrase"],
            wrapped_recovery=user["wrapped_recovery"],
            vault_version=vault_version(db, user_id),
        )

    # --- endpoints ---------------------------------------------------------

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post(f"{API_PREFIX}/prelogin", response_model=PreloginResponse)
    def prelogin(body: PreloginRequest, db: Db) -> PreloginResponse:
        """
        A device that has never seen this account needs both sets of parameters:
        the light one to derive the auth key `/v1/login` wants, and the heavy one
        to derive the encryption key once the code has come back. Unknown emails
        get the current defaults rather than a 404, so this cannot be used to
        enumerate accounts.
        """
        row = db.execute(
            "SELECT kdf_params, auth_kdf_params FROM users WHERE email = %s",
            (normalise_email(body.email),),
        ).fetchone()
        params = json.loads(row["kdf_params"]) if row else DEFAULT_KDF
        # NULL for an account made before the auth key had a derivation of its
        # own. It cannot sign in either way — see MIGRATIONS in db.py — so the
        # defaults here are simply the answer that gives nothing away.
        stored_auth = row["auth_kdf_params"] if row else None
        auth_params = json.loads(stored_auth) if stored_auth else DEFAULT_AUTH_KDF
        return PreloginResponse(kdf=KdfParams(**params), auth_kdf=KdfParams(**auth_params))

    @app.post(
        f"{API_PREFIX}/register",
        response_model=ChallengeResponse,
        status_code=status.HTTP_202_ACCEPTED,
    )
    def register(body: RegisterRequest, request: Request, db: Db) -> ChallengeResponse:
        """
        Sends the code that will create the account, and does nothing else: no
        row in `users`, no key material taken. Both arrive together at
        `/v1/verify`, which is what lets the client run its slow key derivation
        while the code is in transit instead of before it can be sent.

        202 rather than 201 for exactly that reason — the registration has been
        accepted, and whether it becomes an account is up to whoever reads the
        inbox.
        """
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

        # Recorded before anything else so failed attempts count too, otherwise
        # the throttle can be sidestepped by hammering an email that already exists.
        record_event(db, REGISTRATION, ip, now)

        existing = db.execute(
            "SELECT id, verified_at FROM users WHERE email = %s", (email,)
        ).fetchone()
        if existing is not None:
            if existing["verified_at"] is not None:
                raise HTTPException(
                    status.HTTP_409_CONFLICT, "That email address is already registered."
                )
            # Left over from before registration became two requests: an account
            # nobody ever confirmed holds no data and proves nothing about who
            # owns the address. The rows go with it via ON DELETE CASCADE.
            db.execute("DELETE FROM users WHERE id = %s", (existing["id"],))

        return start_registration(db, request, email, now)

    @app.post(f"{API_PREFIX}/login", response_model=ChallengeResponse)
    def login(body: LoginRequest, request: Request, db: Db) -> ChallengeResponse:
        """
        Checks the first factor and sends the second. No token comes out of here
        — see `/v1/verify` — so a passphrase on its own opens nothing.

        The auth key arrives first so that no code is ever sent to an address on
        a wrong passphrase. It is the light derivation's output: the client is a
        moment away from having it, rather than the several seconds the
        encryption key costs, and that one runs after the code comes back.
        """
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

        row = db.execute("SELECT * FROM users WHERE email = %s", (email,)).fetchone()
        stored_hash = row["auth_key_hash"] if row else DUMMY_AUTH_KEY_HASH
        if not crypto.verify_auth_key(crypto.decode_b64(body.auth_key), stored_hash) or row is None:
            record_event(db, LOGIN_FAILURE, throttle_key, now)
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED, "Email address or passphrase is incorrect."
            )

        db.execute(
            "DELETE FROM throttle_events WHERE kind = %s AND key = %s",
            (LOGIN_FAILURE, throttle_key),
        )

        # Legacy: an account created before registration became two requests may
        # sit unverified with its keys already stored. The code it is about to
        # receive doubles as the confirmation its address never gave.
        purpose = LOGIN if row["verified_at"] is not None else REGISTER
        return start_challenge(db, request, row["id"], email, purpose, now)

    def verify_challenge(challenge: Row, body: VerifyRequest, db: Db, now: int) -> LoginResponse:
        """
        A code against an existing account — a sign-in's second factor, or a
        legacy account still waiting on its first confirmation. Any key material
        on the request is ignored: the account already has its own.
        """
        check_code(db, EMAIL_CHALLENGES, challenge, body.code, now)

        user_id = challenge["user_id"]
        with db.transaction():
            # Single use, and it goes before the session exists rather than
            # after: a crash between the two must not leave the code live. The
            # row count is what makes that hold under two requests arriving at
            # once — the second blocks on the first's row lock, then finds
            # nothing to delete, so only one of them gets a session.
            consumed = db.execute(
                "DELETE FROM email_challenges WHERE id = %s", (challenge["id"],)
            ).rowcount
            if not consumed:
                raise HTTPException(
                    status.HTTP_410_GONE, "That code has already been used."
                )
            db.execute(
                "UPDATE users SET verified_at = COALESCE(verified_at, %s), updated_at = %s"
                " WHERE id = %s",
                (now, now, user_id),
            )
            token, expires_at = issue_session(db, user_id, now)

        return session_response(db, user_id, token, expires_at)

    def verify_registration(pending: Row, body: VerifyRequest, db: Db, now: int) -> LoginResponse:
        """
        The code plus the key material, which together are what create the
        account. Until this succeeds the address holds nothing: no keys, no
        vault, nothing a stranger could have reserved.

        The code is checked first and the material second, which makes a request
        carrying only a code a way to ask whether that code is right: a wrong one
        spends an attempt and answers 401, a right one is left unspent and
        answers `material_required`. The client uses that when its derivation is
        still running, so a mistyped code fails now rather than after it.
        """
        check_code(db, PENDING_REGISTRATIONS, pending, body.code, now)

        if (
            body.auth_key is None
            or body.kdf is None
            or body.auth_kdf is None
            or body.wrapped_passphrase is None
            or body.wrapped_recovery is None
        ):
            # The right code from a client that has not said what the account is
            # made of. The code is not spent on it: the same client can retry
            # with the material included.
            #
            # Reaching this at all is the answer to "is this code right?", and
            # the client asks it deliberately — it will not spend seconds of
            # Argon2id readying material for a code that was mistyped. So the
            # reason is structured rather than prose: it is read, not shown.
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                {
                    "reason": "material_required",
                    "message": "A registration is verified with its key material. Include it.",
                },
            )

        # `/v1/register` checks this too, but the account is created here, and a
        # burst of registrations racing for the last seats must not overshoot.
        if settings.max_users:
            total = db.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
            if int(total) >= settings.max_users:
                raise HTTPException(
                    status.HTTP_503_SERVICE_UNAVAILABLE, "This server is not accepting new accounts."
                )

        user_id = uuid.uuid4().hex
        try:
            with db.transaction():
                consumed = db.execute(
                    "DELETE FROM pending_registrations WHERE id = %s", (pending["id"],)
                ).rowcount
                if not consumed:
                    raise HTTPException(
                        status.HTTP_410_GONE, "That code has already been used."
                    )
                db.execute(
                    "INSERT INTO users (id, email, auth_key_hash, kdf_params, auth_kdf_params,"
                    " wrapped_passphrase, wrapped_recovery, created_at, updated_at, verified_at)"
                    " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                    (
                        user_id,
                        pending["email"],
                        crypto.hash_auth_key(crypto.decode_b64(body.auth_key)),
                        body.kdf.model_dump_json(),
                        body.auth_kdf.model_dump_json(),
                        body.wrapped_passphrase,
                        body.wrapped_recovery,
                        now,
                        now,
                        now,
                    ),
                )
                db.execute(
                    "INSERT INTO vaults (user_id, version, ciphertext, updated_at)"
                    " VALUES (%s, 0, NULL, %s)",
                    (user_id, now),
                )
                token, expires_at = issue_session(db, user_id, now)
        except UniqueViolation as err:
            # A verified account materialised under this address in the window
            # since `/v1/register` looked. Vanishingly rare, and the honest
            # answer is the same one register would have given.
            raise HTTPException(
                status.HTTP_409_CONFLICT, "That email address is already registered."
            ) from err

        return session_response(db, user_id, token, expires_at)

    @app.post(f"{API_PREFIX}/verify", response_model=LoginResponse)
    def verify(body: VerifyRequest, db: Db) -> LoginResponse:
        """
        The only endpoint that issues a session, the only one that marks an
        address verified, and — for a registration — the one that creates the
        account. The code is consumed here whatever happens next: it is deleted
        on success, and the challenge is destroyed once the guesses run out, so
        a code is good for exactly one attempt at being right.
        """
        now = int(time.time())
        prune(db, now)

        challenge = db.execute(
            "SELECT * FROM email_challenges WHERE id = %s", (body.challenge_id,)
        ).fetchone()
        if challenge is not None:
            return verify_challenge(challenge, body, db, now)

        pending = db.execute(
            "SELECT * FROM pending_registrations WHERE id = %s", (body.challenge_id,)
        ).fetchone()
        if pending is not None:
            return verify_registration(pending, body, db, now)

        raise HTTPException(
            status.HTTP_410_GONE, "That request has expired. Start again from sign-in."
        )

    @app.post(f"{API_PREFIX}/verify/resend", response_model=ChallengeResponse)
    def resend(body: ResendRequest, request: Request, db: Db) -> ChallengeResponse:
        """
        A fresh code for a challenge already in hand, so a five minute expiry
        does not cost the user another passphrase and another Argon2id run. The
        new code replaces the old one, which stops working immediately.
        """
        now = int(time.time())
        prune(db, now)

        challenge = db.execute(
            "SELECT email_challenges.*, users.email AS email FROM email_challenges"
            " JOIN users ON users.id = email_challenges.user_id WHERE email_challenges.id = %s",
            (body.challenge_id,),
        ).fetchone()
        if challenge is not None:
            return start_challenge(
                db,
                request,
                challenge["user_id"],
                challenge["email"],
                challenge["purpose"],
                now,
                deadline=int(challenge["expires_at"]),
            )

        pending = db.execute(
            "SELECT * FROM pending_registrations WHERE id = %s", (body.challenge_id,)
        ).fetchone()
        if pending is not None:
            return start_registration(
                db, request, pending["email"], now, deadline=int(pending["expires_at"])
            )

        raise HTTPException(
            status.HTTP_410_GONE, "That request has expired. Start again from sign-in."
        )

    @app.post(f"{API_PREFIX}/session/refresh", response_model=SessionRefreshResponse)
    def refresh_session(session: CurrentSession, db: Db) -> SessionRefreshResponse:
        """
        Puts the full term back on a live session.

        This is what keeps the emailed code a rare event instead of a fortnightly
        one. The client calls it when the device's own check has been passed, so
        what renews a session is the fingerprint or passcode of whoever is
        holding the phone — the thing that is actually guarding the codes between
        sign-ins.

        A session that has already lapsed cannot be renewed from here: it fails
        the dependency above, and the way back in is both factors.
        """
        now = int(time.time())
        prune(db, now)

        expires_at = now + settings.token_ttl_seconds
        db.execute(
            "UPDATE sessions SET expires_at = %s WHERE token_hash = %s",
            (expires_at, session.token_hash),
        )
        return SessionRefreshResponse(user_id=session.user_id, expires_at=expires_at)

    @app.post(f"{API_PREFIX}/logout", status_code=status.HTTP_204_NO_CONTENT)
    def logout(session: CurrentSession, db: Db) -> Response:
        db.execute("DELETE FROM sessions WHERE token_hash = %s", (session.token_hash,))
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @app.get(f"{API_PREFIX}/vault", response_model=VaultResponse)
    def get_vault(session: CurrentSession, db: Db) -> VaultResponse:
        row = db.execute(
            "SELECT version, ciphertext, updated_at FROM vaults WHERE user_id = %s",
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
        with db.transaction():
            # FOR UPDATE is what makes the version check mean anything. Under
            # READ COMMITTED two PUTs naming the same base version would both
            # read it, both find it current, and the second would overwrite the
            # first — the lost update SQLite's BEGIN IMMEDIATE ruled out by
            # letting only one writer in at a time. Locking the row here makes
            # the loser wait, re-read the version it was given, and get its 409.
            row = db.execute(
                "SELECT version, ciphertext, updated_at FROM vaults WHERE user_id = %s"
                " FOR UPDATE",
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
                "UPDATE vaults SET version = %s, ciphertext = %s, updated_at = %s WHERE user_id = %s",
                (next_version, blob, now, session.user_id),
            )

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
            "SELECT auth_key_hash FROM users WHERE id = %s", (session.user_id,)
        ).fetchone()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No such account")

        if not crypto.verify_auth_key(crypto.decode_b64(body.current_auth_key), row["auth_key_hash"]):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Current passphrase is incorrect.")

        with db.transaction():
            db.execute(
                "UPDATE users SET auth_key_hash = %s, kdf_params = %s, auth_kdf_params = %s,"
                " wrapped_passphrase = %s, wrapped_recovery = %s, updated_at = %s WHERE id = %s",
                (
                    crypto.hash_auth_key(crypto.decode_b64(body.new_auth_key)),
                    body.kdf.model_dump_json(),
                    body.auth_kdf.model_dump_json(),
                    body.wrapped_passphrase,
                    body.wrapped_recovery,
                    now,
                    session.user_id,
                ),
            )
            # Every existing session was authorised under the old passphrase.
            db.execute("DELETE FROM sessions WHERE user_id = %s", (session.user_id,))
            token, expires_at = issue_session(db, session.user_id, now)

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
            "SELECT auth_key_hash FROM users WHERE id = %s", (session.user_id,)
        ).fetchone()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No such account")
        if not crypto.verify_auth_key(crypto.decode_b64(body.auth_key), row["auth_key_hash"]):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Passphrase is incorrect.")

        # Vault and sessions go with it via ON DELETE CASCADE.
        db.execute("DELETE FROM users WHERE id = %s", (session.user_id,))
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return app
