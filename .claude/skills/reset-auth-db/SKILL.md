---
name: reset-auth-db
description: Empty the local sync server's auth tables (users, vaults, sessions, email challenges, rate limits) for a clean sign-up test. Use when re-testing register/sign-in against the dev server, when a repeated attempt returns 429 Too Many Requests, or when an account needs to be removed so its address can be registered again.
---

# Reset the local auth database

Clears accounts and rate limits from the development server's Postgres so a
sign-up can be tested from scratch.

Default target is the `authenticator` database on the PostgreSQL installed on
Windows, resolved through `server/deploy/dev_database_url.py` — the same script
`npm run server` uses, so the two cannot drift apart. It is resolved rather than
written down because WSL2 reaches the Windows host by an address that changes
whenever WSL restarts.

**Never point this at the droplet** — anything whose host is not this machine is
refused outright, including the `postgres` name the app container reaches its
database by.

## Running it

The script needs psycopg, which lives in the server's uv environment rather than
the system python, so it is run through uv.

A run without `--yes` reports the row counts and what it would clear, and changes
nothing. Always do that first and show the user the counts.

```bash
# See what is there
uv run --project server python .claude/skills/reset-auth-db/scripts/reset_auth_db.py

# Full clean start: every account plus the rate limits
uv run --project server python .claude/skills/reset-auth-db/scripts/reset_auth_db.py --yes

# Just the rate limits, when a retry is coming back 429
uv run --project server python .claude/skills/reset-auth-db/scripts/reset_auth_db.py --throttles-only --yes

# One address, so it can be registered again
uv run --project server python .claude/skills/reset-auth-db/scripts/reset_auth_db.py --email me@example.com --yes
```

Other flags: `--database-url URL` for a different database, `--keep-throttles` to
leave the limits standing, `--force` to proceed past the "more accounts than a dev
database should hold" guard.

Ask the user before running with `--yes`. The deletion is not reversible, and a
dev database can still hold the only copy of a test vault.

## What it touches

Six tables, from `server/app/db.py`:

| Table | Cleared by |
| --- | --- |
| `users` | default, or `--email` |
| `vaults`, `sessions`, `email_challenges` | cascade from `users` |
| `pending_registrations` | default, or `--email` — keyed by email, no user row exists yet |
| `throttle_events` | default, or `--throttles-only` |

## Things worth knowing

- **`throttle_events` has no foreign key**, so it survives a user cascade. This is
  usually the actual complaint: `MAX_REGISTRATIONS_PER_IP=5` and
  `MAX_CODES_PER_EMAIL=5` over a 15–60 minute window, so the fourth or fifth
  sign-up test starts returning 429 even after the accounts are gone.
- **A `registration` 429 cannot be cleared per address.** That counter is keyed by
  IP alone, unlike `code_send` (`email:<address>`) and `login_failure`
  (`<address>|<ip>`). Use a full run or `--throttles-only`, not `--email`.
- **Rows are deleted, the tables are not.** `uvicorn --reload` holds a pool of
  open connections; dropping the schema under them leaves the next request
  failing instead of starting clean. No server restart is needed after this.
- **The device keeps its own state.** `sync_account` and `sync_session` live in
  SecureStore and the vault stays on disk, so after a server-side wipe the app
  still looks signed in to an account that no longer exists — the next call that
  needs the token 401s. Sign out in the app (or clear its data) for a true clean
  start.
- **`verified_at` is what gates a session.** A registration never confirmed by a
  code sits in `pending_registrations` (no `users` row exists until the code
  comes back), and registering the same address again replaces it — so an
  unfinished registration is not itself a reason to run this. Only legacy
  accounts, created before registration became two requests, can sit in `users`
  with `verified_at` NULL.

## Checking the script

```bash
uv run --project server pytest .claude/skills/reset-auth-db/scripts/ -q
```

They run in the dev database — there is no separate test one — but never in its
`public` schema: each test creates a schema of its own, reaches it through a
`search_path` on the connection string, and drops it afterwards, so what the
script clears is the fixture's rows rather than anything the dev server put
there. The tables are built from the real schema imported from `server/app/db.py`,
so a table or cascade that changes there fails here rather than leaving this
quietly clearing four tables out of five. They skip rather than fail when the dev
Postgres is not running.

A crashed run can leave an empty `reset_…` or `empty_…` schema behind. Harmless,
and `DROP SCHEMA` clears it.
