"""
The Gmail API sender, against a stubbed Google.

Nothing here reaches the network: `GmailApiMailer` builds its own `httpx.Client`,
so the tests swap `mail.httpx.Client` for one wired to a `MockTransport` and
assert on what it was asked to send. What is worth pinning down is not the happy
path — that is two POSTs — but the things that only misbehave in production: the
access token being reused rather than re-minted per message, and one expired
token not costing a user their sign-up.
"""

from __future__ import annotations

import base64
import email
import json
from dataclasses import replace

import httpx
import pytest

from app import mail
from app.mail import GmailApiMailer, Message, SendFailed, build_mailer

SETTINGS_FIELDS = {
    "google_client_id": "client-id.apps.googleusercontent.com",
    "google_client_secret": "client-secret",
    "google_refresh_token": "refresh-token",
    "email_from": "Authenticator <no-reply@example.com>",
}

MESSAGE = Message(to="user@example.com", subject="Your sign-in code", body="123456")


def _install(monkeypatch, handler) -> None:
    """
    Points the mailer's client at `handler`. `mail.httpx` is the httpx module
    itself, so the real class has to be captured before the attribute is
    replaced — building the stand-in out of the patched name calls the stand-in.
    """
    real_client = httpx.Client
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        mail.httpx,
        "Client",
        lambda **kwargs: real_client(**{**kwargs, "transport": transport}),
    )


@pytest.fixture
def mail_settings(settings):
    return replace(settings, **SETTINGS_FIELDS)


class FakeGoogle:
    """
    Stands in for both endpoints. `token_responses` and `send_responses` are
    consumed in order, so a test can make the first send fail and the second
    succeed; the last entry repeats once the list runs out.
    """

    def __init__(self, token_responses=None, send_responses=None) -> None:
        self.token_responses = list(token_responses or [(200, {"access_token": "at-1", "expires_in": 3600})])
        self.send_responses = list(send_responses or [(200, {"id": "m1"})])
        self.token_requests: list[dict] = []
        self.send_requests: list[httpx.Request] = []

    def _next(self, queue):
        return queue.pop(0) if len(queue) > 1 else queue[0]

    def handle(self, request: httpx.Request) -> httpx.Response:
        if str(request.url) == mail.TOKEN_ENDPOINT:
            self.token_requests.append(dict(httpx.QueryParams(request.content.decode())))
            status, body = self._next(self.token_responses)
            return httpx.Response(status, json=body)

        assert str(request.url) == mail.SEND_ENDPOINT, request.url
        self.send_requests.append(request)
        status, body = self._next(self.send_responses)
        return httpx.Response(status, json=body)

    def install(self, monkeypatch) -> None:
        _install(monkeypatch, self.handle)

    @property
    def sent_message(self) -> email.message.Message:
        raw = json.loads(self.send_requests[-1].content)["raw"]
        return email.message_from_bytes(base64.urlsafe_b64decode(raw))


def test_sends_the_message_over_the_api(mail_settings, monkeypatch):
    google = FakeGoogle()
    google.install(monkeypatch)

    GmailApiMailer(mail_settings).send(MESSAGE)

    # The grant, exactly as Google's refresh flow wants it.
    assert google.token_requests == [
        {
            "grant_type": "refresh_token",
            "refresh_token": "refresh-token",
            "client_id": "client-id.apps.googleusercontent.com",
            "client_secret": "client-secret",
        }
    ]

    request = google.send_requests[-1]
    assert request.headers["Authorization"] == "Bearer at-1"

    sent = google.sent_message
    assert sent["To"] == "user@example.com"
    assert sent["Subject"] == "Your sign-in code"
    assert sent["From"] == "Authenticator <no-reply@example.com>"
    # Set so an autoresponder does not bounce the code back out in a quoted reply.
    assert sent["Auto-Submitted"] == "auto-generated"
    assert "123456" in sent.get_payload()


def test_access_token_is_reused_across_messages(mail_settings, monkeypatch):
    google = FakeGoogle()
    google.install(monkeypatch)

    mailer = GmailApiMailer(mail_settings)
    mailer.send(MESSAGE)
    mailer.send(MESSAGE)
    mailer.send(MESSAGE)

    # One token for three messages. Minting per message would triple the latency
    # of every sign-up and is a round trip Google does not want either.
    assert len(google.token_requests) == 1
    assert len(google.send_requests) == 3


def test_expired_access_token_is_reminted(mail_settings, monkeypatch):
    google = FakeGoogle(
        token_responses=[
            # Shorter than TOKEN_EXPIRY_MARGIN_SECONDS, so it is already spent
            # by the time the second message is sent.
            (200, {"access_token": "at-1", "expires_in": 1}),
            (200, {"access_token": "at-2", "expires_in": 3600}),
        ]
    )
    google.install(monkeypatch)

    mailer = GmailApiMailer(mail_settings)
    mailer.send(MESSAGE)
    mailer.send(MESSAGE)

    assert len(google.token_requests) == 2
    assert google.send_requests[0].headers["Authorization"] == "Bearer at-1"
    assert google.send_requests[1].headers["Authorization"] == "Bearer at-2"


def test_rejected_token_is_retried_once_with_a_fresh_one(mail_settings, monkeypatch):
    google = FakeGoogle(
        token_responses=[
            (200, {"access_token": "stale", "expires_in": 3600}),
            (200, {"access_token": "fresh", "expires_in": 3600}),
        ],
        send_responses=[(401, {"error": "invalid_credentials"}), (200, {"id": "m1"})],
    )
    google.install(monkeypatch)

    # No exception: a token revoked mid-life is not the user's problem, and the
    # retry costs one round trip against making them ask for another code.
    GmailApiMailer(mail_settings).send(MESSAGE)

    assert [r.headers["Authorization"] for r in google.send_requests] == [
        "Bearer stale",
        "Bearer fresh",
    ]


def test_a_second_rejection_gives_up(mail_settings, monkeypatch):
    google = FakeGoogle(send_responses=[(401, {"error": "invalid_credentials"})])
    google.install(monkeypatch)

    with pytest.raises(SendFailed) as err:
        GmailApiMailer(mail_settings).send(MESSAGE)

    assert "401" in str(err.value)
    # Retried exactly once, rather than looping on a credential that will not work.
    assert len(google.send_requests) == 2


def test_a_withdrawn_grant_names_itself(mail_settings, monkeypatch):
    google = FakeGoogle(token_responses=[(400, {"error": "invalid_grant"})])
    google.install(monkeypatch)

    with pytest.raises(SendFailed) as err:
        GmailApiMailer(mail_settings).send(MESSAGE)

    # This one is a deployment problem, not a bad morning — every code will fail
    # identically until the refresh token is re-minted, so the log says where to go.
    assert "invalid_grant" in str(err.value)
    assert "README" in str(err.value)
    assert not google.send_requests


def test_a_rejected_message_fails_the_send(mail_settings, monkeypatch):
    google = FakeGoogle(send_responses=[(403, {"error": "Gmail API has not been used"})])
    google.install(monkeypatch)

    with pytest.raises(SendFailed) as err:
        GmailApiMailer(mail_settings).send(MESSAGE)

    assert "403" in str(err.value)


def test_an_unreachable_google_fails_the_send(mail_settings, monkeypatch):
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    _install(monkeypatch, refuse)

    with pytest.raises(SendFailed) as err:
        GmailApiMailer(mail_settings).send(MESSAGE)

    assert "unreachable" in str(err.value)


@pytest.mark.parametrize(
    "missing",
    ["google_client_id", "google_client_secret", "google_refresh_token"],
)
def test_build_mailer_refuses_incomplete_credentials(mail_settings, missing):
    # A server that boots without these looks healthy and cannot sign anyone in,
    # because every code fails at the send. Better to refuse to start.
    with pytest.raises(ValueError) as err:
        build_mailer(replace(mail_settings, **{missing: ""}))

    assert missing.upper() in str(err.value)


def test_build_mailer_accepts_complete_credentials(mail_settings):
    assert isinstance(build_mailer(mail_settings), GmailApiMailer)
