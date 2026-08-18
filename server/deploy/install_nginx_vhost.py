#!/usr/bin/env python3
"""
Splices the authenticator vhost into nginx-proxy-prod's shared template.

nginx-proxy-prod mounts a single template file rather than a conf.d directory, so
each service keeps the authoritative copy of its own vhost in its own repo and
this script writes it into the shared file between marker comments. Running it
again replaces the block rather than appending a second copy.

    sudo ./deploy/install_nginx_vhost.py            # write, then restart nginx
    sudo ./deploy/install_nginx_vhost.py --check    # report only, change nothing

Note that a RESTART is required, not `nginx -s reload`: the container renders
/etc/nginx/conf.d from the template at entrypoint, so a running nginx never
re-reads the template.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

DEFAULT_TEMPLATE = Path("/root/gym_junkie_server/nginx/nginx.conf.template")
DEFAULT_FRAGMENT = Path(__file__).resolve().parent.parent / "nginx" / "authenticator.moates.com.au.conf"

START_MARKER = "# >>> authenticator vhost >>>"
END_MARKER = "# <<< authenticator vhost <<<"


def extract_block(fragment: str) -> str:
    """Returns the marked block from the fragment, verifying both markers exist."""
    start = fragment.find(START_MARKER)
    end = fragment.find(END_MARKER)
    if start == -1 or end == -1:
        raise SystemExit(f"fragment is missing {START_MARKER!r} or {END_MARKER!r}")
    if end < start:
        raise SystemExit("fragment markers are in the wrong order")
    return fragment[start : end + len(END_MARKER)]


def splice(template: str, block: str) -> str:
    """Replaces an existing managed block, or appends one if there is none."""
    start = template.find(START_MARKER)
    end = template.find(END_MARKER)

    if start == -1 and end == -1:
        separator = "" if template.endswith("\n\n") else "\n" if template.endswith("\n") else "\n\n"
        return f"{template}{separator}{block}\n"

    if start == -1 or end == -1:
        raise SystemExit(
            "template contains only one of the two markers — refusing to guess; fix it by hand"
        )

    return template[:start] + block + template[end + len(END_MARKER) :]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--template", type=Path, default=DEFAULT_TEMPLATE)
    parser.add_argument("--fragment", type=Path, default=DEFAULT_FRAGMENT)
    parser.add_argument(
        "--check", action="store_true", help="report whether a change is needed and exit"
    )
    args = parser.parse_args()

    if not args.template.is_file():
        raise SystemExit(f"template not found: {args.template}")
    if not args.fragment.is_file():
        raise SystemExit(f"fragment not found: {args.fragment}")

    block = extract_block(args.fragment.read_text())
    template = args.template.read_text()
    updated = splice(template, block)

    if updated == template:
        print(f"{args.template}: already up to date")
        return 0

    if args.check:
        action = "replace" if START_MARKER in template else "append"
        print(f"{args.template}: would {action} the authenticator vhost block")
        return 1

    # Keep a copy of what was there, and swap the new file in atomically so a
    # failure part-way through cannot leave every site without a config.
    backup = args.template.with_suffix(args.template.suffix + ".bak")
    backup.write_text(template)

    temporary = args.template.with_suffix(args.template.suffix + ".tmp")
    temporary.write_text(updated)
    os.replace(temporary, args.template)

    action = "replaced" if START_MARKER in template else "appended"
    print(f"{args.template}: {action} the authenticator vhost block (previous copy at {backup})")
    print("now run: docker restart nginx-proxy-prod")
    return 0


if __name__ == "__main__":
    sys.exit(main())
