#!/usr/bin/env python3.12
"""
Sends one real verification email, to check the Gmail credentials without
standing a server up.

    uv run python deploy/send_test_email.py
    uv run python deploy/send_test_email.py --to someone@example.com

Settings come from server/.env, the same file docker compose hands the container,
so a send that works here is a send that will work in production — this is the
credentials being wrong or right, not a separate code path. The message is the
genuine template with a placeholder code, because the two things worth learning
from a test send are whether the login is accepted and which folder the result
lands in, and a message that reads differently answers the second one wrongly.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import deploy.env_file as env_file  # noqa: E402
from app.config import load_settings  # noqa: E402
from app.mail import GmailApiMailer, SendFailed, verification_message  # noqa: E402

# Not a code anyone could use. It never reaches the database, and the point is
# to see the shape of the message rather than to complete a sign-in.
PLACEHOLDER_CODE = "000000"

# load_settings() insists on a database URL, since a server that cannot reach
# Postgres should fail to boot rather than guess. Nothing here opens a
# connection, so a syntactically valid placeholder is enough to get past it.
PLACEHOLDER_DATABASE_URL = "postgresql://unused:unused@127.0.0.1:5432/unused"


def apply_env() -> None:
    env_file.load()
    os.environ.setdefault("DATABASE_URL", PLACEHOLDER_DATABASE_URL)


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--to",
        help="Recipient. Defaults to the EMAIL_FROM address, so the account mails itself.",
    )
    parser.add_argument(
        "--purpose",
        choices=("register", "login"),
        default="register",
        help="Which of the two templates to send. Default: register.",
    )
    args = parser.parse_args()

    apply_env()
    settings = load_settings()

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
        print(
            f"{', '.join(missing)} not set. Fill in the email block in server/.env"
            " — the refresh token comes from deploy/google_oauth_token.py.",
            file=sys.stderr,
        )
        return 1

    # The From header is the only address configured now, so it is also the only
    # sensible default recipient: the account mails itself.
    recipient = args.to or _address(settings.email_from)
    if not recipient:
        print("No --to, and EMAIL_FROM has no address in it.", file=sys.stderr)
        return 1

    message = verification_message(
        recipient,
        PLACEHOLDER_CODE,
        args.purpose,
        settings.code_ttl_seconds,
    )

    print("Sending via the Gmail API (HTTPS, no SMTP port involved)")
    print(f"  from {settings.email_from}")
    print(f"  to   {recipient}")
    # Piped output is block-buffered while stderr is not, so without this a
    # failure prints above the settings that caused it.
    sys.stdout.flush()

    try:
        GmailApiMailer(settings).send(message)
    except SendFailed as err:
        print(f"\nFailed: {err}", file=sys.stderr)
        # The two that actually happen, and neither error text says which.
        print(
            "\n'invalid_grant' on the refresh token means it has expired or been"
            " revoked — the usual cause is an OAuth consent screen still in"
            " Testing, which expires tokens after seven days. A 403 on the send"
            " means the Gmail API is not enabled on the project.",
            file=sys.stderr,
        )
        return 1

    print("\nSent. Check the inbox, and check spam — where it lands is half the test.")
    print(
        "\nCheck the From header on what arrived. Gmail rewrites it to the mailbox"
        " the refresh token belongs to unless EMAIL_FROM is a verified"
        " 'Send mail as' alias of it.",
    )
    return 0


def _address(email_from: str) -> str:
    """Pulls the bare address out of a "Name <addr>" pair, or passes one through."""
    if "<" in email_from and ">" in email_from:
        return email_from.split("<", 1)[1].split(">", 1)[0].strip()
    return email_from.strip()


if __name__ == "__main__":
    raise SystemExit(main())
