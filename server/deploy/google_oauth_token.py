#!/usr/bin/env python3
"""
Mint the refresh token that `GOOGLE_REFRESH_TOKEN` holds.

Run once, on a machine with a browser, signed in as the *sending mailbox* — not
as whoever owns the Google Cloud project. The client id and secret identify the
app; this step is what makes it that particular mailbox, and getting it wrong is
how codes end up arriving from somebody's personal address.

The prerequisites, done once in the Google Cloud console — see "The sending
account" in ../README.md for the walkthrough:

  1. A project, with the **Gmail API** enabled.
  2. An OAuth consent screen, **External**, published to **In production**. Left
     in Testing, Google expires every refresh token after seven days, and the
     server starts answering 502 again a week after it was set up.
  3. An OAuth client of type **Desktop app**. Its id and secret are what this
     script asks for.

Nothing here talks to the server or its database, and nothing is written to
disk: the token is printed, and goes into `.env` by hand.

    uv run python deploy/google_oauth_token.py

Google hands out a refresh token only on the *first* consent for a given
client/account pair, so this asks for `prompt=consent` to force a fresh one
every time. Re-running it is therefore safe, and is the fix if the token is ever
lost or revoked — the previous one keeps working until it is revoked at
https://myaccount.google.com/permissions.
"""

from __future__ import annotations

import http.server
import secrets
import socket
import sys
import threading
import urllib.parse
import webbrowser

import httpx

AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"

# Must match app/mail.py. Sending is all the server does with this grant, and a
# token that could read the mailbox would be a much worse thing to leak.
SCOPE = "https://www.googleapis.com/auth/gmail.send"

# The page the browser is left on. Deliberately blunt about which account was
# used: picking the wrong one in Google's account chooser is the easy mistake
# here, and it is invisible afterwards — the token works, the mail just comes
# from the wrong address.
DONE_PAGE = """<!doctype html>
<meta charset="utf-8">
<title>Authenticator</title>
<body style="font:16px/1.5 system-ui;max-width:34em;margin:4em auto;padding:0 1em">
<h1 style="font-size:1.3em">Done — you can close this tab.</h1>
<p>The refresh token has been printed in the terminal.</p>
<p><strong>Check which account you just approved.</strong> It must be the
mailbox the codes should come from. If it was not, revoke it at
<a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>
and run the script again.</p>
"""


# Set once the redirect actually arrives, so the main thread knows to stop
# waiting. A plain flag would do; the event is what makes the wait interruptible.
CAPTURED = threading.Event()


class _Catcher(http.server.BaseHTTPRequestHandler):
    """
    Catches the redirect Google makes back to us.

    Serves until the redirect arrives rather than handling a single request:
    browsers open speculative connections and ask for /favicon.ico, and a server
    that stopped after the first of those would not be listening for the one
    request that matters.
    """

    code: str | None = None
    state: str | None = None
    error: str | None = None

    def do_GET(self) -> None:  # noqa: N802 — the name is BaseHTTPRequestHandler's
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        if not (query.get("code") or query.get("error")):
            # Not the redirect. Answer it and keep waiting.
            self.send_response(204)
            self.end_headers()
            return

        _Catcher.code = (query.get("code") or [None])[0]
        _Catcher.state = (query.get("state") or [None])[0]
        _Catcher.error = (query.get("error") or [None])[0]

        body = DONE_PAGE.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        CAPTURED.set()

    def log_message(self, *_args: object) -> None:
        """Silence the default stderr access log; it would print the code."""


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("", 0))
        return int(sock.getsockname()[1])


def _from_pasted_url(pasted: str) -> None:
    """
    The fallback when the browser could not reach us. Under WSL2 the browser is
    on Windows and this server is not, and the loopback relay between them is the
    part that fails — but the address bar still holds the redirect, code and all,
    even though the page itself did not load.
    """
    query = urllib.parse.parse_qs(urllib.parse.urlparse(pasted.strip()).query)
    _Catcher.code = (query.get("code") or [None])[0]
    _Catcher.state = (query.get("state") or [None])[0]
    _Catcher.error = (query.get("error") or [None])[0]


def _prompt(label: str) -> str:
    value = input(f"{label}: ").strip()
    if not value:
        sys.exit(f"{label} is required.")
    return value


def main() -> int:
    print(__doc__.strip().split("\n\n")[0])
    print()
    client_id = _prompt("GOOGLE_CLIENT_ID")
    client_secret = _prompt("GOOGLE_CLIENT_SECRET")

    port = _free_port()
    redirect_uri = f"http://localhost:{port}"
    # Ties the redirect back to this run, so a stray request to the loopback
    # port cannot feed us somebody else's authorisation code.
    state = secrets.token_urlsafe(24)

    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": SCOPE,
        "access_type": "offline",
        # Without this, a second run for an account that has already consented
        # returns an access token and no refresh token.
        "prompt": "consent",
        "state": state,
    }
    url = f"{AUTH_ENDPOINT}?{urllib.parse.urlencode(params)}"

    # Bound on every interface rather than 127.0.0.1: under WSL2 the browser is a
    # Windows process and this is not, and Windows' loopback relay into WSL is
    # unreliable for a socket bound only to WSL's own 127.0.0.1. The listener
    # lives for one redirect, and the code it catches is useless without the
    # client secret, which never leaves this terminal.
    server = http.server.HTTPServer(("", port), _Catcher)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    print()
    print("Sign in as the mailbox the codes should come from, and approve.")
    print("If no browser opens, paste this in:")
    print()
    print(f"  {url}")
    print()
    print("Expect a 'Google hasn't verified this app' screen — that is this app,")
    print("unverified because it has one user. Advanced, bottom left, then")
    print("'Go to ...'. Not the developer address in the middle of the page: that")
    print("is a mailto: link, and it opens your mail client, not the consent form.")
    print()
    webbrowser.open(url)

    captured = CAPTURED.wait(timeout=300)
    server.shutdown()
    server.server_close()

    if not captured:
        # The browser could not reach us. It still got the redirect, so the code
        # is sitting in the address bar of a page that failed to load.
        print("Nothing arrived on the loopback port.")
        print()
        print("Look at your browser's address bar. Even if the page failed to")
        print("load, the URL should start with http://localhost: and contain")
        print("'code='. Copy the whole thing and paste it here.")
        print()
        pasted = input("Redirect URL (or Enter to give up): ").strip()
        if not pasted:
            return _fail("No authorisation code came back.")
        _from_pasted_url(pasted)

    if _Catcher.error:
        return _fail(f"Google returned an error: {_Catcher.error}")
    if not _Catcher.code:
        return _fail("That URL has no 'code=' in it.")
    if _Catcher.state != state:
        return _fail("The redirect's state did not match. Nothing has been used.")

    response = httpx.post(
        TOKEN_ENDPOINT,
        data={
            "grant_type": "authorization_code",
            "code": _Catcher.code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
        },
        timeout=20.0,
    )
    if response.status_code != httpx.codes.OK:
        return _fail(f"Token exchange failed: {response.status_code} {response.text}")

    refresh_token = response.json().get("refresh_token")
    if not refresh_token:
        return _fail(
            "Google returned no refresh token. That happens when the account has"
            " already consented and prompt=consent was not honoured — revoke this"
            " app at https://myaccount.google.com/permissions and run this again."
        )

    print()
    print("Put these three in server/.env — the refresh token is a secret:")
    print()
    print(f"GOOGLE_CLIENT_ID={client_id}")
    print(f"GOOGLE_CLIENT_SECRET={client_secret}")
    print(f"GOOGLE_REFRESH_TOKEN={refresh_token}")
    print()
    print("Then set EMAIL_FROM to that same mailbox, or to a verified alias of it,")
    print("and send yourself one with: uv run python deploy/send_test_email.py")
    return 0


def _fail(reason: str) -> int:
    print(f"\n{reason}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
