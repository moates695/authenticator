#!/usr/bin/env python3.12
"""
Starts the development server, which is `npm run server`.

This was an inline command in package.json until the console mailer was removed.
Now that every code goes out by real email, the dev server needs the SMTP
credentials from server/.env, and that file cannot be sourced by a shell —
EMAIL_FROM holds `Authenticator <address>`, and `<` is a redirect. Working it
out here also puts the dev server, the test suite and send_test_email.py on the
same two helpers rather than on a command line nobody reads.

Anything already exported wins, so a one-off run against other settings needs no
edit:

    SMTP_USERNAME=other@gmail.com uv run python deploy/dev_server.py
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import deploy.dev_database_url as dev_database_url  # noqa: E402
import deploy.env_file as env_file  # noqa: E402

# The phone is the thing that needs to reach this, so not loopback. See
# "Reaching it from a phone, on WSL2" in the README for the Windows side.
DEV_HOST = "0.0.0.0"
DEV_PORT = 8000


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--host", default=DEV_HOST)
    parser.add_argument("--port", type=int, default=DEV_PORT)
    parser.add_argument(
        "--no-reload",
        action="store_true",
        help="Serve once instead of watching for edits.",
    )
    args = parser.parse_args()

    # Read before .env is loaded, because .env sets DATABASE_URL too — to the
    # droplet's database, reachable only from inside the compose network but
    # wrong in a way that would be found late. An override has to come from the
    # shell to count; the file's copy is deliberately ignored, and the local
    # address is worked out fresh because WSL2's gateway moves.
    exported_database_url = os.environ.get("DATABASE_URL", "").strip()

    env_file.load()

    os.environ["DATABASE_URL"] = exported_database_url or dev_database_url.dev_database_url()
    # Development only. A public API explorer on an auth service is an invitation.
    os.environ.setdefault("ENABLE_DOCS", "1")

    if not os.environ.get("SMTP_HOST"):
        print(
            "No SMTP_HOST. Codes are no longer printed to the log, so sign-in"
            " will fail at the first send. Fill in the email block in"
            " server/.env — see 'The sending account' in server/README.md.",
            file=sys.stderr,
        )
        return 1

    print(f"Database  {os.environ['DATABASE_URL']}")
    print(f"Mail      {os.environ.get('SMTP_USERNAME')} via {os.environ['SMTP_HOST']}")
    print("Codes are sent by email — there is no console fallback.\n")
    sys.stdout.flush()

    command = [
        "uvicorn",
        "app.main:create_app",
        "--factory",
        "--host",
        args.host,
        "--port",
        str(args.port),
    ]
    if not args.no_reload:
        command.append("--reload")

    # exec rather than subprocess, so Ctrl-C reaches uvicorn directly and this
    # process is not left between the terminal and the reloader.
    os.execvp(command[0], command)


if __name__ == "__main__":
    raise SystemExit(main())
