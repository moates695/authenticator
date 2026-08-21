"""
Outbound email. There is exactly one message — a six-digit code — so this is a
sender and a template rather than a mail framework.

This used to be smtplib, on the reasoning that the standard library beat binding
the server to one vendor's SDK. The droplet settled the question the other way:
its provider blocks outbound 25, 465 and 587 — every SMTP port, to every host,
not just Google's — so a code sent over SMTP from production spent the timeout
going nowhere and the sign-up answered 502. Port 443 is open, so the message goes
over the Gmail API instead.

That is still not a vendor SDK. `google-api-python-client` would drag in most of
Google's client stack to send one message; what the API actually needs is two
HTTPS calls — a refresh token exchanged for an access token, then the RFC 5322
message posted base64url-encoded — so those two are written out here against
httpx. The mailbox and its credentials are the same kind of secret as the app
password they replace, and open the same one mailbox.

Sending is synchronous, inside the request that asked for it. A code that never
arrives is the one failure the user cannot work around from the verification
screen, so it is worth holding the response open for — a background task can
only report a success it has not yet earned.
"""

from __future__ import annotations

import base64
import threading
import time
from dataclasses import dataclass, field
from email.message import EmailMessage
from typing import Protocol

import httpx

from .config import Settings

# Long enough for Google having a slow morning, short enough that the app's own
# 20 second request timeout is not what gives up first. Two calls share it, so
# the worst case is twice this — still inside the budget.
HTTP_TIMEOUT_SECONDS = 8.0

TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"

# The only scope this needs. It cannot read the mailbox, and it cannot read the
# rest of the account — worth keeping narrow, because the grant is long-lived.
GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"

# An access token lasts an hour. Treating it as spent early means a message is
# never sent with one that expires in flight.
TOKEN_EXPIRY_MARGIN_SECONDS = 120


@dataclass(frozen=True)
class Message:
    to: str
    subject: str
    body: str


class SendFailed(RuntimeError):
    """The message could not be handed to Google."""


class Mailer(Protocol):
    def send(self, message: Message) -> None: ...


class GmailApiMailer:
    """
    What production runs. Credentials come from the environment; note that the
    refresh token is the only secret the server holds, and it opens one mailbox
    under one scope — no key here can decrypt anything a user has stored, and
    this one cannot even read the mail it sends.
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        # Guarded because FastAPI runs sync endpoints in a threadpool: two
        # sign-ups landing together would otherwise each mint a token and race to
        # store it. Cheap to hold — everything under it is local.
        self._lock = threading.Lock()
        self._access_token: str | None = None
        self._expires_at = 0.0

    def send(self, message: Message) -> None:
        payload = EmailMessage()
        payload["From"] = self._settings.email_from
        payload["To"] = message.to
        payload["Subject"] = message.subject
        # Marks the message as transactional, so a well-behaved autoresponder
        # does not reply to a no-reply address with the code quoted underneath.
        payload["Auto-Submitted"] = "auto-generated"
        payload.set_content(message.body)

        raw = base64.urlsafe_b64encode(payload.as_bytes()).decode("ascii")

        with httpx.Client(timeout=HTTP_TIMEOUT_SECONDS) as client:
            response = self._post_message(client, raw, self._token(client))
            if response.status_code == httpx.codes.UNAUTHORIZED:
                # The cached token was refused — revoked, or the clock drifted
                # past its life. Mint a fresh one and give the message its one
                # second chance, rather than failing a sign-up over a token the
                # next request would have replaced anyway.
                self._forget_token()
                response = self._post_message(client, raw, self._token(client))

            if response.status_code != httpx.codes.OK:
                # The body is logged, never returned: a rejection can name the
                # mailbox, and the endpoint answers strangers.
                raise SendFailed(
                    f"Gmail API refused the message: {response.status_code}"
                    f" {response.text[:300]}"
                )

    def _post_message(self, client: httpx.Client, raw: str, token: str) -> httpx.Response:
        try:
            return client.post(
                SEND_ENDPOINT,
                headers={"Authorization": f"Bearer {token}"},
                json={"raw": raw},
            )
        except httpx.HTTPError as err:
            raise SendFailed(f"Gmail API unreachable: {err}") from err

    def _token(self, client: httpx.Client) -> str:
        with self._lock:
            if self._access_token and time.monotonic() < self._expires_at:
                return self._access_token

            settings = self._settings
            try:
                response = client.post(
                    TOKEN_ENDPOINT,
                    data={
                        "grant_type": "refresh_token",
                        "refresh_token": settings.google_refresh_token,
                        "client_id": settings.google_client_id,
                        "client_secret": settings.google_client_secret,
                    },
                )
            except httpx.HTTPError as err:
                raise SendFailed(f"Google token endpoint unreachable: {err}") from err

            if response.status_code != httpx.codes.OK:
                # Worth its own message: this one means the credentials are
                # wrong or the grant has been withdrawn, which is a deployment
                # problem rather than a bad morning, and every code will fail
                # the same way until someone re-mints the refresh token.
                raise SendFailed(
                    f"Google refused the refresh token: {response.status_code}"
                    f" {response.text[:300]} — see 'The sending account' in"
                    f" server/README.md"
                )

            body = response.json()
            token = body.get("access_token")
            if not token:
                raise SendFailed("Google returned no access token")

            self._access_token = token
            self._expires_at = (
                time.monotonic() + float(body.get("expires_in", 3600)) - TOKEN_EXPIRY_MARGIN_SECONDS
            )
            return token

    def _forget_token(self) -> None:
        with self._lock:
            self._access_token = None
            self._expires_at = 0.0


@dataclass
class MemoryMailer:
    """Keeps every message in a list. What the tests read the code back out of."""

    sent: list[Message] = field(default_factory=list)

    def send(self, message: Message) -> None:
        self.sent.append(message)

    @property
    def last(self) -> Message:
        return self.sent[-1]


def build_mailer(settings: Settings) -> Mailer:
    """
    There is one of these and it sends mail. There used to be a second that
    printed the code to the log for development, which was a mistake worth
    naming: it meant the second factor was a configuration flag away from being
    no factor at all, on every environment, and the difference never showed up
    in a test — the suite substitutes its own mailer either way. Development now
    sends real mail through the real account, which is also the only way to find
    out that codes are landing in spam before a user does.
    """
    missing = [
        name
        for name, value in (
            ("GOOGLE_CLIENT_ID", settings.google_client_id),
            ("GOOGLE_CLIENT_SECRET", settings.google_client_secret),
            ("GOOGLE_REFRESH_TOKEN", settings.google_refresh_token),
        )
        if not value
    ]
    if missing:
        raise ValueError(
            f"{', '.join(missing)} not set. The server sends every verification"
            " code by email, so an account that cannot be mailed cannot be signed"
            " into — see 'The sending account' in server/README.md, and mint the"
            " refresh token with deploy/google_oauth_token.py."
        )
    return GmailApiMailer(settings)


def verification_message(email: str, code: str, purpose: str, ttl_seconds: int) -> Message:
    """
    Deliberately plain text, deliberately short. No link to click: a code the
    user carries to the app cannot be forwarded into someone else's session by
    a phishing page wearing our styling.
    """
    minutes = max(1, round(ttl_seconds / 60))
    opening = (
        "Confirm your email address to finish setting up your account."
        if purpose == "register"
        else "Here is the code to finish signing in."
    )

    body = (
        f"{opening}\n"
        f"\n"
        f"    {code}\n"
        f"\n"
        f"It expires in {minutes} minutes and works once.\n"
        f"\n"
        f"If this was not you, nothing has happened and there is nothing to do."
        f" Someone typed your address; without this code they cannot get in.\n"
    )

    # The code stays out of the subject. It would be handy in a notification
    # preview, but the inbox is often on the same phone as the app, and a code
    # readable from a locked screen is not much of a second factor.
    subject = "Confirm your email address" if purpose == "register" else "Your sign-in code"
    return Message(to=email, subject=subject, body=body)
