#!/usr/bin/env python3.12
"""
Reads server/.env into the environment, for the things that run outside a
container.

Production never calls this: docker compose passes the same file through
`env_file`, so the settings arrive as real environment variables. It exists
because development now sends real mail — there is no console mailer any more —
and the credentials for that have to come from somewhere the dev server can see.

Sourcing the file from the shell was the obvious alternative and does not work:
EMAIL_FROM holds `Authenticator <address>`, and `<` is a redirect.
"""

from __future__ import annotations

import os
from pathlib import Path

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


def parse(path: Path = ENV_FILE) -> dict[str, str]:
    """
    A minimal reader for the `KEY=value` subset docker compose's env_file
    accepts. No interpolation and no `export`, because the file it reads has
    neither, and a parser that handled more would be inventing a format nothing
    writes.
    """
    values: dict[str, str] = {}
    if not path.exists():
        return values

    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        value = value.strip()
        # Quotes are optional in this format and are not part of the value.
        # EMAIL_FROM carries spaces and angle brackets unquoted, so anything
        # unquoted is taken verbatim.
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def load(path: Path = ENV_FILE) -> dict[str, str]:
    """
    Fills gaps only: anything already exported wins, so a one-off run against
    different credentials needs no edit to the file. Returns what it read, for
    a caller that wants to report on it.
    """
    values = parse(path)
    for key, value in values.items():
        os.environ.setdefault(key, value)
    return values
