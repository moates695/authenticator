# Authenticator sync server

Holds one encrypted blob per account and nothing else. It cannot read a vault:
the auth key it verifies comes from its own derivation, and the key that unwraps
the data key never leaves the device.

What it stores per account: an email address, a scrypt digest of the auth key,
the client's Argon2id parameters for both of its derivations, two wrapped copies
of the 32-byte data key (passphrase and recovery key), the encrypted vault with a
version counter, and when the address was verified.

The scrypt over the auth key is sized at 64 MiB per verification rather than the
token amount a digest of high-entropy input would need. The client's auth-key
pass is deliberately light — it runs before `/v1/login` will send a code, so the
user is waiting on it — which makes this the larger half of what a passphrase
guess costs anyone who takes this database.

The SMTP password is the only secret here, and it opens a mailbox rather than a
vault. There is still no server-side key that can decrypt anything a user stored.

Registration is open. The guardrails are a per-IP registration throttle, a per-IP
and per-email login throttle, a per-address cap on how many codes can be sent, a
ceiling on vault size, and an optional account cap — see `.env.example`.

## Two factors

A passphrase alone gets nobody in. `/v1/register` and `/v1/login` check what
they can and then email a six-digit code, returning a challenge; `/v1/verify` is
the only endpoint that issues a session, and the only one that marks an address
verified. A session is refused outright while `users.verified_at` is NULL, so an
address that has never answered a code is an account that cannot be used.

Registration takes nothing but the address: the account itself — auth key, KDF
parameters, both wrapped data keys — arrives with the code at `/v1/verify`, and
does not exist before then. That order is what lets the client run its
deliberately slow key derivation while the code is in transit and the user is
off reading their inbox, instead of making the email wait on the derivation.

A sign-in cannot borrow that order, because a code must not go to an address
whose passphrase was wrong. `/v1/login` therefore takes the auth key first — but
the client derives that one under light parameters, so it costs a moment rather
than the several seconds the encryption key takes. That derivation happens on the
device after `/v1/verify` has accepted the code, and this server never sees it.

The rules on a code:

- **Six digits, five minutes, one use.** Verifying deletes it. Issuing one
  deletes whatever was outstanding for that account, so an address never has two
  live codes.
- **Five wrong guesses** destroy the challenge — the real defence, since a
  million possibilities is not much on its own.
- **The challenge outlives the code**, half an hour against five minutes, so a
  code that expires while the user is looking for it costs a `resend` rather
  than another passphrase and another Argon2id run.
- **A registration nobody confirmed can be registered over.** Until its code
  comes back it is a row in `pending_registrations` holding nothing but a code
  hash; refusing to replace it would let a stranger reserve an address they
  cannot read, permanently.

### Staying signed in

Both factors are for adopting a device, not for using one. A session lasts
`TOKEN_TTL_SECONDS` (a fortnight) without being used, and `/v1/session/refresh`
puts the full term back on a live one. The app calls it when the device's own
unlock check is passed, so what keeps a phone signed in is its owner's
fingerprint or passcode rather than how recently they read an email.

The token is extended, never reissued: it is already in the device's keystore,
and rotating it would mean a reply lost on a bad connection cost the user a
passphrase and a code. A session that has already lapsed cannot be renewed —
that is the one thing the endpoint will not do, and the way back is both factors.

Accounts created before any of this existed come out of the migration
unverified. Their next sign-in emails a code and sets the column, which is the
same path a new account takes; what it costs them is one re-login, since their
existing sessions stop working immediately.

## API

All binary fields are standard base64 with padding. Bearer token in
`Authorization`.

| Endpoint | Body | Returns |
| --- | --- | --- |
| `GET /health` | — | `{status}` |
| `POST /v1/prelogin` | `{email}` | `{kdf, auth_kdf}` — Argon2id parameters for the encryption key and for the auth key. Unknown emails get the current defaults for both, so this cannot enumerate accounts |
| `POST /v1/register` | `{email}` | `202 {challenge_id, email, purpose, code_expires_at, expires_at}` and a code in the inbox. No session, and no account yet — that is created at verify. `409` if the email belongs to a verified account |
| `POST /v1/login` | `{email, auth_key}` | `202`-shaped challenge as above, `purpose: "login"`. `401` on a wrong auth key, before anything is sent. The auth key is the light derivation's, so the client reaches this in a moment |
| `POST /v1/verify` | `{challenge_id, code}` plus, for a registration, `{auth_key, kdf, auth_kdf, wrapped_passphrase, wrapped_recovery}` | `{user_id, token, expires_at, kdf, wrapped_passphrase, wrapped_recovery, vault_version}`. `400` registration without its material, `401` wrong code, `410` expired or unknown challenge, `429` out of guesses |
| `POST /v1/verify/resend` | `{challenge_id}` | A new challenge, and a new code that kills the old one. `410` once the challenge itself has gone |
| `POST /v1/session/refresh` | — | `{user_id, expires_at}` — the same token, good for another full term. `401` once the session has lapsed |
| `POST /v1/logout` | — | `204` |
| `GET /v1/vault` | — | `{version, ciphertext, updated_at}`. `ciphertext` is `null` until the first push |
| `PUT /v1/vault` | `{base_version, ciphertext}` | `{version, updated_at}`, or `409` — see below. `413` past `MAX_CIPHERTEXT_BYTES` |
| `PUT /v1/keys` | `{current_auth_key, new_auth_key, kdf, auth_kdf, wrapped_passphrase, wrapped_recovery}` | `{user_id, token, ...}`. Passphrase change or recovery-key rotation. Revokes every existing session and leaves the vault ciphertext untouched |
| `POST /v1/account/delete` | `{auth_key}` | `204`. Irreversible; needs the auth key as well as a session |

A `409` from `PUT /v1/vault` carries everything needed to merge in one round trip:

```json
{"detail": {"reason": "version_mismatch", "version": 4,
            "ciphertext": "…", "updated_at": 1770000000}}
```

The client merges that against its local vault, then retries with
`base_version` set to the returned `version`.

## Local development

Everything lives in Postgres, named by `DATABASE_URL`. There is no default: a
server that cannot reach its database fails to boot with a reason, rather than
quietly opening a local one and looking fine while it collects accounts nobody
will find again.

Two environments, dev and production, and they never meet. Production is
`authenticator` on the droplet's own Postgres container; dev is `authenticator`
on the PostgreSQL 17 installed on Windows. Nothing is shared, so a test account
cannot appear in production — provided the app is pointed here rather than at the
droplet, which is what `EXPO_PUBLIC_SYNC_URL` is for and why a development build
refuses to start without it.

The test suite runs against the dev database too, and is kept off its rows by a
schema per test rather than by a database of its own: it creates `test_…`,
reaches it through a `search_path` on the connection string, and drops it at the
end. Nothing in the suite qualifies a table name or names `public`, so a test
cannot reach out of the schema it was given; the worst a crashed run leaves is an
empty schema. `TEST_DATABASE_URL` points the suite elsewhere if that is ever
wanted — deliberately not `DATABASE_URL`, so a shell that already has the
server's environment in it cannot quietly decide where the tests run.

Dev is on 17 and the droplet on 16. Nothing here uses anything newer than 16, so
this works, but it is a difference worth remembering when reading a plan or a
error message that turns out to be version-specific.

**One-time setup**, against the Windows install, as `postgres`:

```sql
CREATE ROLE authenticator LOGIN PASSWORD 'devpassword';
CREATE DATABASE authenticator OWNER authenticator;
```

Then, from the repo root:

```bash
npm run server
```

which is `deploy/dev_server.py`: it reads `.env` for the SMTP credentials, works
out the local database address, turns `/docs` on and execs uvicorn on
`0.0.0.0:8000`.

The credentials have to come from somewhere now that codes are always emailed,
and `.env` cannot simply be sourced by the shell — `EMAIL_FROM` holds
`Authenticator <address>`, and `<` is a redirect. Anything already exported wins,
so a one-off run against other settings needs no edit to the file:

```bash
cd server
SMTP_USERNAME=other@gmail.com uv run python deploy/dev_server.py
```

`DATABASE_URL` is the one exception: `.env` carries the droplet's, which is
reachable only from inside the compose network, so the file's copy is ignored and
only a shell export counts. The local address comes from
`deploy/dev_database_url.py` rather than a literal, because there isn't a stable
one to write down — WSL2 is in NAT mode here, so the Windows host is the default
gateway and that address changes whenever WSL restarts. The script works it out,
falling back to the `host.docker.internal` that Docker Desktop maintains in
`/etc/hosts`. The test suite and the `reset-auth-db` skill go through the same
script, so there is one place to change if any of this moves.

The dev password is in git on purpose: it reaches a Postgres on this machine
holding a handful of test accounts. The droplet's password is not — it comes from
`.env`.

`ENABLE_DOCS=1` exposes `/docs`. Leave it off in production.

To empty the dev database between sign-up tests, use the `reset-auth-db` skill.

`--host 0.0.0.0` rather than the default loopback, because the thing that needs
to reach it is a phone.

### Reaching it from a phone, on WSL2

WSL2 runs on a NAT'd network of its own, so the server is at a `172.31.x`
address the phone has no route to. Windows has to forward its LAN port across,
in an **elevated** PowerShell:

```powershell
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=8000 `
  connectaddress=$(wsl hostname -I).Trim().Split()[0] connectport=8000
New-NetFirewallRule -DisplayName "Authenticator dev server" -Direction Inbound `
  -Protocol TCP -LocalPort 8000 -Action Allow
```

The phone then reaches it at the Windows LAN address — `192.168.0.231` at the
time of writing, `ipconfig` for the current one — which is what belongs in the
app's `.env`.

Two things to know. The WSL address changes when WSL restarts, so the
`portproxy` line has to be re-run after a reboot (`netsh interface portproxy
show v4tov4` to see what is registered). And the phone has to be on the same
Wi-Fi, which `expo start --tunnel` does not arrange — the tunnel carries the JS
bundle, not the app's own requests.

Codes are emailed here exactly as they are in production. There was an
`EMAIL_CONSOLE=1` that printed them to the log instead, and it is gone: it made
the second factor one environment variable away from being no factor at all, and
because the test suite substitutes its own mailer, no test would ever have
noticed if that variable were set somewhere it should not be. Development uses
the real account, which also means spam placement gets noticed here rather than
by a user.

The cost is that `npm run server` will not start without an SMTP host — it says
so and exits rather than booting into a server that cannot sign anyone in.

### The sending account

Gmail, which is enough for a handful of messages a day and needs no DNS work.
Three things about it are not obvious.

It will not accept the account password. Turn on 2-Step Verification, then take a
16-character **app password** from
[myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
and strip its spaces — that is what `SMTP_PASSWORD` holds. If 2-Step Verification
is set up with security keys only, the app password option does not appear at
all, so leave a phone or an authenticator enrolled as well.

It rewrites the `From` header. Gmail sends as the authenticated account unless
the address in `EMAIL_FROM` is a verified *Send mail as* alias, and verifying one
means receiving a confirmation code at it — so
`no-reply@authenticator.moates.com.au` needs mail to be receivable on that domain
first. Until then `EMAIL_FROM` should carry the Gmail address, so that the header
and the envelope agree rather than one being silently replaced.

And the account should be a dedicated one. The app password is a whole-mailbox
credential sitting in `.env` on the droplet, which is not something to hand out
on behalf of a personal inbox. Its own second factor should be somewhere other
than this app: if a bad deploy ever breaks sign-in, the recovery path should not
run through the mailbox that is down.

To check the credentials without standing a server up:

```bash
cd server
uv run python deploy/send_test_email.py            # mails the account itself
uv run python deploy/send_test_email.py --to me@elsewhere.example
```

It reads the same `.env` docker compose hands the container and sends the real
template with a placeholder code, so it answers both of the questions a test send
is for: whether the login is accepted, and which folder the result lands in. A
consumer Gmail has no sending reputation for transactional mail, so spam
placement is worth looking at before trusting it. Swapping the four `SMTP_*`
values for a transactional provider later needs no code change.

## Deploying to the droplet

The service joins the existing `backend-prod_api-network` and is reached by
container name from `nginx-proxy-prod`. It publishes no ports. The wildcard
`*.moates.com.au` Cloudflare origin certificate is already mounted for the
sibling sites, so no new certificate is needed.

**One manual prerequisite:** a Cloudflare DNS record for
`authenticator.moates.com.au`, proxied, pointing at the droplet.

```bash
# On the droplet
git clone <this repo> /opt/authenticator      # or pull, if already cloned
cd /opt/authenticator/server
cp .env.example .env
# Fill in POSTGRES_PASSWORD and put the same password into DATABASE_URL. Neither
# has a default, and the app container will not start without both.
docker compose up -d --build

# Only when coming from the old SQLite build: move the accounts across before
# anyone signs in, so a fresh empty database is not what they find. The old
# ./data directory is no longer mounted by the service, so mount it just for
# this — writable, because the old database is in WAL mode and SQLite cannot
# open one without being able to write its sidecar files. Reports and stops
# without --yes.
docker compose run --rm -v /opt/authenticator/server/data:/data authenticator \
  python deploy/migrate_sqlite_to_postgres.py --sqlite /data/authenticator.db

# Splice the vhost into the shared nginx template and restart the proxy
sudo ./deploy/install_nginx_vhost.py
docker restart nginx-proxy-prod
```

`docker restart`, not `nginx -s reload`: nginx-proxy-prod renders
`/etc/nginx/conf.d` from the mounted template at entrypoint, so a running nginx
never re-reads the template. The script keeps a `.bak` of the previous template
and writes the new one atomically.

Verify:

```bash
curl -s https://authenticator.moates.com.au/health
```

## Ops notes

- **Rate limiting is nginx-only, not fail2ban.** As documented on the
  `vault.moates.com.au` block, this service is Dockerised (published ports are
  DNAT'd past the INPUT chain) and Cloudflare-proxied (the packet source is the CF
  edge), so an iptables jail cannot ban HTTP offenders. The controls that work are
  the `limit_req` zones keyed on the real IP recovered from `CF-Connecting-IP`,
  the Cloudflare-only origin lock, and optionally a Cloudflare rate-limit rule.
- **Cloudflare IP ranges** are duplicated in the vhost (snapshot 2026-07-22) and
  must be kept in step with the `vault.moates.com.au` block.
- **Backups.** The `pgdata` volume is the only state. Add a `pg_dump` to the same
  age-encrypted pipeline as Vaultwarden — never `cp` the volume out from under a
  running Postgres:

  ```bash
  docker compose exec -T postgres pg_dump -U authenticator authenticator | age -r … > backup.sql.age
  ```

- **Restoring.** Bring up an empty `postgres` service, then feed the dump back in
  with `psql -U authenticator authenticator`. The app creates its own schema at
  startup, so a restore into a database the server has already touched wants an
  empty one first.
- **Migrating off the old SQLite.** `deploy/migrate_sqlite_to_postgres.py` moves
  an existing `authenticator.db` across, sessions included so the phones already
  out there stay signed in. It reports and stops without `--yes`, and refuses a
  target that already holds rows.
- **Footprint.** Two containers capped at 256MB each, one uvicorn worker, and
  Postgres tuned down to 32MB of shared buffers — this is six small tables, not a
  workload. Access logging is off deliberately: the log would otherwise be a
  record of which accounts synced when.
