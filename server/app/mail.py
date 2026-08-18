"""
Outbound email. There is exactly one message — a six-digit code — so this is a
sender and a template rather than a mail framework.

smtplib from the standard library rather than a provider's SDK: the volume is a
handful of messages a day, and an HTTP client bound to one particular vendor
would be a larger surface than the protocol it replaces.

Sending is synchronous, inside the request that asked for it. A code that never
arrives is the one failure the user cannot work around from the verification
screen, so it is worth holding the response open for — a background task can
only report a success it has not yet earned.
"""

from __future__ import annotations

import smtplib
import ssl
from dataclasses import dataclass, field
from email.message import EmailMessage
from typing import Protocol

from .config import Settings

# Long enough for a provider having a slow morning, short enough that the app's
# own 20 second request timeout is not what gives up first.
SMTP_TIMEOUT_SECONDS = 12.0


@dataclass(frozen=True)
class Message:
    to: str
    subject: str
    body: str


class SendFailed(RuntimeError):
    """The message could not be handed to the SMTP server."""


class Mailer(Protocol):
    def send(self, message: Message) -> None: ...


class SmtpMailer:
    """
    What production runs. Credentials come from the environment; note that this
    is the only secret the server holds, and it opens a mailbox rather than a
    vault — no key here can decrypt anything a user has stored.
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def send(self, message: Message) -> None:
        settings = self._settings

        payload = EmailMessage()
        payload["From"] = settings.email_from
        payload["To"] = message.to
        payload["Subject"] = message.subject
        # Marks the message as transactional, so a well-behaved autoresponder
        # does not reply to a no-reply address with the code quoted underneath.
        payload["Auto-Submitted"] = "auto-generated"
        payload.set_content(message.body)

        try:
            with self._connect() as smtp:
                if settings.smtp_security == "starttls":
                    smtp.starttls(context=ssl.create_default_context())
                if settings.smtp_username:
                    smtp.login(settings.smtp_username, settings.smtp_password)
                smtp.send_message(payload)
        except (OSError, smtplib.SMTPException) as err:
            # The text is logged, never returned: a bounce reason can name the
            # mailbox, and the endpoint answers strangers.
            raise SendFailed(f"SMTP delivery failed: {err}") from err

    def _connect(self) -> smtplib.SMTP:
        settings = self._settings
        if settings.smtp_security == "ssl":
            return smtplib.SMTP_SSL(
                settings.smtp_host,
                settings.smtp_port,
                timeout=SMTP_TIMEOUT_SECONDS,
                context=ssl.create_default_context(),
            )
        return smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=SMTP_TIMEOUT_SECONDS)


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
    if not settings.smtp_host:
        raise ValueError(
            "SMTP_HOST is not set. The server sends every verification code by"
            " email, so an account that cannot be mailed cannot be signed into —"
            " see 'The sending account' in server/README.md."
        )
    return SmtpMailer(settings)


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
