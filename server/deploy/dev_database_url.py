#!/usr/bin/env python3.12
"""
Where the development Postgres is, worked out at the moment it is asked for.

Postgres runs on Windows; this repository is developed from WSL2 in NAT mode,
where the Windows host is the default gateway and that address changes whenever
WSL restarts. So nothing hardcodes it — `npm run server`, the test suite and the
reset-auth-db skill all come through here, which is also why there is only one
place to change if the setup moves.

    python3.12 dev_database_url.py

$DATABASE_URL wins if it is already set, so a one-off run against something else
needs no argument.
"""

from __future__ import annotations

import argparse
import os
import socket
import subprocess

DEV_USER = "authenticator"
# Not a secret: it reaches a Postgres on this machine holding test accounts. The
# droplet's password lives in server/.env and is nothing to do with this.
DEV_PASSWORD = "devpassword"
DEV_PORT = 5432

# The only database on this machine. There were two, until the second turned out
# to be a third environment that did not exist: the suite isolates itself with a
# schema per test, which is what actually keeps it away from the dev server's
# rows, so a database of its own was buying nothing.
DEV_DATABASE = "authenticator"

# Tried in order after the default gateway. `host.docker.internal` is maintained
# in /etc/hosts by Docker Desktop, so it is a fallback rather than the answer:
# the point of using the Windows install is not to need Docker running.
FALLBACK_HOSTS = ("host.docker.internal", "127.0.0.1")


def gateway_host() -> str | None:
    """The Windows host as WSL2 sees it in NAT mode: the default route."""
    try:
        route = subprocess.run(
            ["ip", "route", "show", "default"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None

    for line in route.stdout.splitlines():
        fields = line.split()
        if "via" in fields:
            return fields[fields.index("via") + 1]
    return None


def reachable(host: str, port: int = DEV_PORT, timeout: float = 1.5) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except (OSError, socket.gaierror):
        return False


def dev_host() -> str:
    """
    The first candidate with something answering on the Postgres port. Falls back
    to the gateway when nothing answers, so the caller fails with a connection
    error naming a plausible address rather than this raising something vaguer.
    """
    candidates = [host for host in (gateway_host(), *FALLBACK_HOSTS) if host]
    for host in candidates:
        if reachable(host):
            return host
    return candidates[0] if candidates else "127.0.0.1"


def dev_database_url(database: str = DEV_DATABASE) -> str:
    return f"postgresql://{DEV_USER}:{DEV_PASSWORD}@{dev_host()}:{DEV_PORT}/{database}"


def resolve(database: str = DEV_DATABASE, env_var: str = "DATABASE_URL") -> str:
    """What every caller should use: an explicit setting, or the local default."""
    return os.environ.get(env_var, "").strip() or dev_database_url(database)


def main() -> int:
    argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    ).parse_args()
    print(resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
