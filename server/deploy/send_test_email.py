#!/usr/bin/env python3.12
"""
Sends one real verification email, to check SMTP credentials without standing a
server up.

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
from app.mail import SendFailed, SmtpMailer, verification_message  # noqa: E402

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
        help="Recipient. Defaults to SMTP_USERNAME, so the account mails itself.",
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

    if not settings.smtp_host:
        print("SMTP_HOST is not set. Fill in server/.env first.", file=sys.stderr)
        return 1
    if not settings.smtp_username:
        print("SMTP_USERNAME is not set. Gmail will not accept an anonymous send.", file=sys.stderr)
        return 1
    if not settings.smtp_password:
        print(
            "SMTP_PASSWORD is not set. Gmail needs the 16-character app password"
            " from myaccount.google.com/apppasswords, not the account password.",
            file=sys.stderr,
        )
        return 1

    recipient = args.to or settings.smtp_username

    message = verification_message(
        recipient,
        PLACEHOLDER_CODE,
        args.purpose,
        settings.code_ttl_seconds,
    )

    print(f"Sending via {settings.smtp_host}:{settings.smtp_port} ({settings.smtp_security})")
    print(f"  as   {settings.smtp_username}")
    print(f"  from {settings.email_from}")
    print(f"  to   {recipient}")
    # Piped output is block-buffered while stderr is not, so without this a
    # failure prints above the settings that caused it.
    sys.stdout.flush()

    try:
        SmtpMailer(settings).send(message)
    except SendFailed as err:
        print(f"\nFailed: {err}", file=sys.stderr)
        # The two that actually happen, and neither error text says which.
        print(
            "\n535 means the app password was rejected — check it is the app"
            " password with its spaces stripped, and that 2-Step Verification is"
            " still on. A timeout usually means port 587 is blocked outbound.",
            file=sys.stderr,
        )
        return 1

    print("\nSent. Check the inbox, and check spam — where it lands is half the test.")
    if settings.email_from and settings.smtp_username not in settings.email_from:
        print(
            "\nNote: EMAIL_FROM does not contain SMTP_USERNAME. Unless that address"
            " is a verified 'Send mail as' alias, Gmail will have rewritten the"
            " From header to the account address — compare what arrived.",
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
