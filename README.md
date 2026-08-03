# Authenticator

A TOTP/HOTP authenticator for Android and iOS. Codes group into folders one level
deep, and a single countdown at the top of the screen covers every standard code.

Built with Expo SDK 54 (pinned to `54.0.23`, matching the gym junkie project) and
React Native 0.81.5. Cloud builds via EAS, since iOS cannot be built from this
WSL environment.

## Status

**Phase 1 — done.** Local encrypted vault, TOTP and HOTP code generation, QR
scanning, manual and pasted `otpauth://` entry, folder management, light/dark
theming.

**Phase 2 — next.** Zero-knowledge encrypted backup and sync against the
DigitalOcean droplet. Designed below; nothing built yet. Until it lands, this
device is the only copy of the codes.

**Phase 3 — after that.** Import from other authenticators (Google
Authenticator's `otpauth-migration://` protobuf first, then Aegis, 2FAS and
Bitwarden JSON), plus encrypted export and QR-based device transfer.

## Layout

```
app/                    expo-router screens
  _layout.tsx           providers and themed navigation stack
  index.tsx             code list with the shared countdown
  add.tsx               QR scan and manual entry
  folders.tsx           folder management
  settings.tsx          appearance and vault info
src/
  otp/otp.ts            code generation, otpauth:// parse and format
  otp/clock.tsx         the single app-wide ticker
  vault/types.ts        vault, folder and entry shapes
  vault/vault_crypto.ts encryption and at-rest format
  vault/vault_store.tsx vault state, CRUD, persistence
  theme/                light and dark palettes
  components/           countdown ring, code row
```

## How codes stay correct and cheap to render

One interval drives the whole app, exposed as two contexts. `TickContext`
updates several times a second and only the countdown ring subscribes to it.
`WindowContext` holds the index of the current 30-second TOTP window, so it
changes twice a minute — code rows subscribe to that instead and re-render only
when their code actually changes. The ticker stops while the app is backgrounded
and resyncs on return.

Entries that do not use a 30-second period, and HOTP entries which have no
countdown at all, cannot be represented by the shared ring. Those rows carry
their own small indicator instead of silently showing the wrong timer.

## At-rest encryption

The vault is a single JSON document encrypted as one blob:

```
byte 0        format version
bytes 1..24   XChaCha20 nonce, fresh on every write
bytes 25..    XChaCha20-Poly1305 ciphertext with appended 16-byte tag
```

The 32-byte data key lives in the platform keystore — Keychain on iOS, Android
Keystore via `expo-secure-store` — and never enters the vault file. Writes go to
a temp file and are moved into place, so an interrupted save cannot leave a
half-written vault. Plaintext exists only in memory.

## Planned sync design

The threat being addressed is **device loss or destruction**, which is the most
likely way to lose access to every account at once. It is not device compromise:
malware on an unlocked phone already has the vault, and a server copy neither
helps nor hurts that case.

TOTP seeds are bearer credentials — anyone holding one can mint valid codes
indefinitely, with no rotation prompt and no breach notification. The server
therefore must never see plaintext, which rules out any design where it stores
the codes.

**Key derivation.** Passphrase and email go through Argon2id to a master key,
which HKDF splits into an auth key and an encryption key. The auth key goes to
the server, which stores only an Argon2 hash of it. The encryption key never
leaves the device. Because the split is one-way, a full server breach yields
neither the passphrase nor anything touching the vault.

**Key wrapping.** The vault is encrypted under a random 32-byte data key; the
encryption key only wraps that data key. Changing the passphrase re-wraps 32
bytes instead of re-encrypting and re-uploading everything.

**Recovery key.** A second wrapping of the data key under 32 random bytes, shown
once at setup for the user to write down. Either the passphrase or the recovery
key unlocks the vault, and the server can read neither. This is mandatory rather
than optional: without it, a forgotten passphrase permanently locks the user out
of every account they own.

**The server is deliberately dumb** — four endpoints, no crypto
responsibilities:

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/register` | Store email, Argon2 hash of the auth key, KDF params, both wrapped data keys |
| `POST /v1/login` | Exchange the auth key for a short-lived session token |
| `GET /v1/vault` | Return `{version, ciphertext, wrapped_keys}` |
| `PUT /v1/vault` | Accept `{base_version, ciphertext}`; `409` with current state on version mismatch |

Writes use optimistic concurrency on the version counter. On a `409` the client
pulls, merges and re-pushes. Merging needs no CRDT: entries carry stable UUIDs
and `updated_at` timestamps, deletes leave tombstones, and a TOTP seed never
changes after creation — so real conflicts are almost always "phone added X
while tablet added Y", which unions cleanly.

Aggressive rate limiting on `/login` is a hard requirement, since that is the
entire brute-force surface.

**Deployment target.** FastAPI plus SQLite in a container at
`/opt/authenticator` on the droplet, added to `nginx-proxy-prod` as another
upstream on a `moates.com.au` subdomain behind Cloudflare, matching how
Vaultwarden is already wired. The box runs seven containers on 2GB with roughly
760MB free, so the footprint has to stay small — SQLite, not another Postgres.

## Development

```bash
npm start            # Metro over an ngrok tunnel; scan the QR with Expo Go
npm run start:lan    # plain LAN mode, for a non-WSL machine
npm test             # jest, including the RFC 6238 vectors
npm run typecheck    # tsc --noEmit
```

`npm start` uses `--tunnel` because this project is developed from WSL2, where
Metro binds to a NAT'd virtual adapter that devices on the LAN cannot reach. The
tunnel routes through ngrok instead, so the phone connects over the internet and
does not need to share a network with the host. It needs `@expo/ngrok`, which is
a dev dependency here.

Every native module in this project is either a first-party `expo-*` package or
one of the libraries Expo Go bundles (svg, screens, safe-area-context,
gesture-handler, reanimated), so Expo Go covers the whole app including camera
scanning and the keystore. A development build (`eas build --profile
development`) is only needed once a third-party native module is added.

`expo` is pinned to the exact version `54.0.23` rather than a `~54.0.x` range, so
`expo start` prints an advisory that it expected a newer patch. That is expected:
the pin is deliberate, to keep this project on the same SDK build as gym junkie.

## Notes

- Folders are single-depth by design. Deleting a folder moves its codes to
  Ungrouped rather than deleting them.
- Export will default to a passphrase-encrypted file. Plaintext `otpauth://`
  export will sit behind an explicit confirmation, because the OS share sheet can
  put seeds straight into iCloud or Drive.
