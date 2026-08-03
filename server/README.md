# Authenticator sync server

Holds one encrypted blob per account and nothing else. It cannot read a vault:
the auth key it verifies is one half of an HKDF split, and the half that unwraps
the data key never leaves the device.

What it stores per account: an email address, a scrypt digest of the auth key, the
client's Argon2id parameters, two wrapped copies of the 32-byte data key
(passphrase and recovery key), and the encrypted vault with a version counter.

Registration is open. The guardrails are a per-IP registration throttle, a per-IP
and per-email login throttle, a ceiling on vault size, and an optional account
cap — see `.env.example`.

## API

All binary fields are standard base64 with padding. Bearer token in
`Authorization`.

| Endpoint | Body | Returns |
| --- | --- | --- |
| `GET /health` | — | `{status}` |
| `POST /v1/prelogin` | `{email}` | `{kdf}` — Argon2id parameters. Unknown emails get the current defaults, so this cannot enumerate accounts |
| `POST /v1/register` | `{email, auth_key, kdf, wrapped_passphrase, wrapped_recovery}` | `201 {user_id, token, expires_at, vault_version}` — a usable session, so the first push needs no second round trip. `409` if the email is taken |
| `POST /v1/login` | `{email, auth_key}` | `{user_id, token, expires_at, kdf, wrapped_passphrase, wrapped_recovery, vault_version}` |
| `POST /v1/logout` | — | `204` |
| `GET /v1/vault` | — | `{version, ciphertext, updated_at}`. `ciphertext` is `null` until the first push |
| `PUT /v1/vault` | `{base_version, ciphertext}` | `{version, updated_at}`, or `409` — see below. `413` past `MAX_CIPHERTEXT_BYTES` |
| `PUT /v1/keys` | `{current_auth_key, new_auth_key, kdf, wrapped_passphrase, wrapped_recovery}` | `{user_id, token, ...}`. Passphrase change or recovery-key rotation. Revokes every existing session and leaves the vault ciphertext untouched |
| `POST /v1/account/delete` | `{auth_key}` | `204`. Irreversible; needs the auth key as well as a session |

A `409` from `PUT /v1/vault` carries everything needed to merge in one round trip:

```json
{"detail": {"reason": "version_mismatch", "version": 4,
            "ciphertext": "…", "updated_at": 1770000000}}
```

The client merges that against its local vault, then retries with
`base_version` set to the returned `version`.

## Local development

```bash
cd server
uv sync
uv run pytest
DB_PATH=./data/dev.db ENABLE_DOCS=1 \
  uv run uvicorn app.main:create_app --factory --reload --port 8000
```

`ENABLE_DOCS=1` exposes `/docs`. Leave it off in production.

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
cp .env.example .env                          # adjust if needed
docker compose up -d --build

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
- **Backups.** `data/authenticator.db` is the only state. Add it to the same
  age-encrypted pipeline as Vaultwarden, and copy it with `VACUUM INTO` or
  `.backup` rather than `cp` — it is a live WAL database.
- **Footprint.** Capped at 256MB, one uvicorn worker, SQLite in WAL mode. Access
  logging is off deliberately: the log would otherwise be a record of which
  accounts synced when.
