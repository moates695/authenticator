# Authenticator

A TOTP/HOTP authenticator for Android and iOS. Codes group into folders one level
deep, and a single countdown at the top of the screen covers every standard code.

Built with Expo SDK 54 and React Native 0.81.5. Cloud builds via EAS, since iOS
cannot be built from this WSL environment.

## Status

**Phase 1 — done.** Local encrypted vault, TOTP and HOTP code generation, QR
scanning, manual and pasted `otpauth://` entry, folder management, light/dark
theming.

**Phase 2 — in progress.** Zero-knowledge encrypted backup against the
DigitalOcean droplet. The server is built, deployed and tested (`server/`, see
its own README). On the client, the account is now mandatory: the key hierarchy,
sign-in and registration, and the vault handover at sign-in are done. What is
left is continuous sync — pushing changes as they happen and merging a `409`
from another device — and signing in with a recovery key, which also needs a
server endpoint that does not exist yet.

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
  settings.tsx          appearance, app lock and vault info
src/
  auth/lock_policy.ts   app lock rules: capability, outcomes, when to re-lock
  auth/device_auth.ts   the expo-local-authentication calls
  auth/lock.tsx         lock state, background re-arming, the preference
  auth/lock_screen.tsx  the cover shown while locked
  otp/otp.ts            code generation, otpauth:// parse and format
  otp/clock.tsx         the single app-wide ticker
  sync/keys.ts          the key hierarchy: both Argon2id passes, wrapping
  sync/js_thread.ts     makes the derivation hand the thread back, so the app lives
  sync/account_policy.ts account rules: validation, stored records, the dev flag
  sync/account.tsx      account state, register, sign in, the data key handover
  sync/api.ts           the sync server's HTTP surface
  sync/sync_url.ts      which server a build talks to, and why dev must say
  sync/base64.ts        standard base64, which React Native does not provide
  sync/session_keeper.tsx  turns passing the device check into a renewed session
  sync/sign_in_screen.tsx  the gate shown until there is an account
  sync/verify_email_screen.tsx  the emailed code, between passphrase and session
  sync/recovery_key_screen.tsx  shown once, after registering
  vault/types.ts        vault, folder and entry shapes
  vault/envelope.ts     the one encrypted container format, shared by all three
  vault/vault_crypto.ts the vault at rest, and the data key in the keystore
  vault/vault_store.tsx vault state, CRUD, persistence
  theme/                light and dark palettes
  components/           countdown ring, code row, form controls
  components/keyboard.tsx  keeps the field being typed into above the keyboard
server/                 sync service: FastAPI, Postgres, four endpoints
  app/                  config, schema, hashing, endpoints
  nginx/                vhost spliced into the droplet's shared template
  deploy/               the splice script
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

`vault/envelope.ts` owns that framing, and the wrapped data keys use it too, so
there is one place where the nonce is generated and the version is checked. The
blob the server holds is byte-identical to the one on disk.

## Accounts and the key hierarchy

An account is not optional. A device holding one-time codes and nothing else is
one drop away from locking its owner out of everything those codes protect, so
the app does not open until there is somewhere for them to be backed up. The
gate covers the navigator; nothing behind it is reachable.

```
passphrase ─┬─Argon2id(8 MiB, 1 pass)───> auth key ──> the server, which
            │                                          stores only a scrypt
            │                                          digest of it
            └─Argon2id(32 MiB, 4 passes)> encryption key ──┐
                                                           │ unwraps
random 32 bytes ─────────────────────────> data key <──────┘
                               │ encrypts
                               └──> the vault, on disk and on the server
```

Two derivations, not one split in half, because they are wanted at opposite ends
of the sign-in. `/v1/login` will not email a code until the auth key proves the
passphrase, so that one has to come first and is kept light — a moment on a
phone. The encryption key is the expensive one and is not derived until the code
has been answered, where the wait has a progress bar and the user is already
through the door. The two are independent: different salts, different parameters,
neither recoverable from the other.

That split has a price, and it is worth stating plainly: an attacker holding the
server's database attacks whichever oracle is cheapest, and the auth key's digest
is now cheaper than the vault's wrapping. The server's scrypt parameters are set
against that — 64 MiB per verification — rather than sitting behind an already
expensive pass.

The encryption key never leaves the device, so the server holds ciphertext it
cannot open. Argon2id runs in pure JS under Hermes, so the parameters are tuned
for that, and both sets are stored per account and handed back by
`/v1/prelogin`, which means they can be raised later without breaking anyone.

The Argon2id salts are derived from the email rather than stored: a per-account
random salt would have to be handed out before the user has proved anything,
which would turn `/v1/prelogin` into an account oracle. The two derivations use
different prefixes, which is what keeps them from being the same key.

The indirection through a data key is what makes a passphrase change cheap —
only the 32 bytes are re-wrapped, never the vault — and what makes a second,
independent way in possible. The same data key is wrapped again under a recovery
key generated on the device and shown exactly once. Signing in with that key is
not built yet; it needs a server endpoint that can hand back `wrapped_recovery`
without a passphrase, and there is none.

Registering wraps the data key already in the keystore rather than minting a new
one, so enrolling an existing device never orphans the codes on it. Signing in on
a device that already holds codes from a different account asks first, since the
account's backup lands on top of them.

### The second factor

The passphrase is one of two. Neither `/v1/register` nor `/v1/login` returns a
session: both send a six-digit code to the address on the account and hand back
a challenge, and `/v1/verify` is the only endpoint that issues a token. An
address that has never answered a code is an account that cannot be used —
indeed, for a new registration, an account that does not exist: `/v1/register`
takes only the address, and the key material rides with the code at
`/v1/verify`. The app uses the gap to run the slow key derivation in the
background while the user fetches the code, so creating an account costs one
wait, not two. Accounts created before verification existed are refused
sessions until their next sign-in confirms them.

Signing in orders the same three things differently. `/v1/login` wants the auth
key up front — no code is ever sent to an address whose passphrase was wrong —
but that is the light derivation, so the code goes out almost immediately. The
slow one runs after `/v1/verify` accepts the code, which is why a mistyped code
costs a retry rather than a wait.

A code works once and lives five minutes. Issuing one destroys whatever was
outstanding for that account, so there is never more than one live code for an
address; verifying deletes it; five wrong guesses destroy the challenge. The
challenge behind the code outlives it by design — half an hour — so a code that
expires while the user is looking for it costs a tap on "send another" rather
than another passphrase and another several seconds of Argon2id.

`sync/verify_email_screen.tsx` is that step. The keys derived on the way to it
are held in memory only: killing the app mid-verification leaves nothing
half-authenticated behind, at the cost of retyping the passphrase.

One address is exempt from the email, so that app testers can get in without an
inbox: the server's `TEST_ACCOUNT_EMAIL` names a single account that is always
given `123456` and is never sent mail. Its passphrase is still checked, and the
fixed code opens nothing else. `TESTER_ACCOUNT.md` has the credentials and what
the exception costs.

### Staying signed in

Both factors adopt a device; they are not asked for on the way to reading a code.
A session lasts a fortnight, and the window slides: `sync/session_keeper.tsx`
calls `/v1/session/refresh` whenever the app is open and the device's own unlock
check has been passed, which puts the full fortnight back. So the thing guarding
the codes between sign-ins is the fingerprint or passcode of whoever is holding
the phone — the check that is actually there each time the app opens — rather
than an email read a month ago.

The renewal is throttled to once every six hours, because an authenticator is
opened for a few seconds at a time and a request per glance buys nothing. A
device that goes unopened long enough for the fortnight to run out is signed out:
the codes stay encrypted on it, but the account is shut until both factors are
given again. `sync/account_policy.ts` holds those rules.

Only the server saying the session is over — a `401` or `403` — signs a device
out. A failed request otherwise means a bad connection, and an authenticator that
logged people out over a dropped packet would be unusable on a train.

For local development, `EXPO_PUBLIC_DEV_AUTO_LOGIN` with an email and passphrase
gets as far as the code screen on startup — a real sign-in against whichever
server the build points at, creating the account if it does not exist. What it
saves is the passphrase and the Argon2id wait, not the code: that is emailed like
any other, so point `EXPO_PUBLIC_DEV_ACCOUNT_EMAIL` at an inbox you can read. See
`.env.example`.

## App lock

Opening the app raises the device's own unlock check — fingerprint, Face ID, or
whatever else is enrolled — through `expo-local-authentication`. The lock is
re-armed whenever the app is backgrounded, not just at launch, so it covers
handing an already-open phone to someone as well as picking a locked one up.

This is a gate, not a second layer of encryption. The vault key is already held
in the platform keystore under `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, so the codes
are unreadable while the device itself is locked; what the gate adds is that an
*unlocked* phone still will not show them to whoever is holding it.

Passing the check does a second job: it renews the sync session, which is what
keeps the emailed code from being asked for every fortnight. See [Staying signed
in](#staying-signed-in).

Two things deliberately let the user through rather than shutting them out:

- **No screen lock on the device.** There is no check that could be passed, so
  the gate does not apply. Settings says so instead of showing a dead switch.
- **The passcode fallback stays enabled.** A wet or unrecognised finger drops to
  the device passcode rather than locking the owner out of their own codes.

The prompt asks for Class 3 biometrics on Android (`biometricsSecurityLevel:
'strong'`); weaker face unlock falls through to the passcode.

Turning the lock off in Settings requires passing the check first — otherwise
the one setting that weakens things is the one setting an unattended open phone
could change.

### Turning it off for local testing

```sh
EXPO_PUBLIC_DISABLE_APP_LOCK=1 npm start
```

Expo inlines `EXPO_PUBLIC_*` at bundle time, so this is fixed for a given build
and a shipped build without the variable cannot have the lock disabled by
anything but the user. It exists because a simulator often has nothing enrolled,
and a passcode prompt on every reload gets old fast. Settings shows the override
rather than pretending the switch works.

## Planned sync design

The threat being addressed is **device loss or destruction**, which is the most
likely way to lose access to every account at once. It is not device compromise:
malware on an unlocked phone already has the vault, and a server copy neither
helps nor hurts that case.

TOTP seeds are bearer credentials — anyone holding one can mint valid codes
indefinitely, with no rotation prompt and no breach notification. The server
therefore must never see plaintext, which rules out any design where it stores
the codes.

**Key derivation.** Passphrase and email go through Argon2id twice, under
different salts: a light pass for the auth key and an expensive one for the
encryption key. The auth key goes to the server, which stores only a scrypt
digest of it. The encryption key never leaves the device. Neither derivation
leads to the other, so a full server breach yields neither the passphrase nor
anything touching the vault — what it does yield is a guessing target costing
one light pass plus the server's scrypt, which is what that scrypt is sized for.

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
| `POST /v1/register` | Take an email address, email a code. Nothing else is stored yet |
| `POST /v1/login` | Check the auth key and email a code. No token comes out of here |
| `POST /v1/verify` | Exchange a challenge and its code for a session token. For a registration, the auth key hash, KDF params and both wrapped data keys arrive here, and this is what creates the account |
| `POST /v1/session/refresh` | Put the full fortnight back on a live session; called when the device check is passed |
| `GET /v1/vault` | Return `{version, ciphertext, wrapped_keys}` |
| `PUT /v1/vault` | Accept `{base_version, ciphertext}`; `409` with current state on version mismatch |

Writes use optimistic concurrency on the version counter. On a `409` the client
pulls, merges and re-pushes. Merging needs no CRDT: entries carry stable UUIDs
and `updated_at` timestamps, deletes leave tombstones, and a TOTP seed never
changes after creation — so real conflicts are almost always "phone added X
while tablet added Y", which unions cleanly.

Aggressive rate limiting on `/login` is a hard requirement, since that is the
entire brute-force surface. `/v1/verify` is throttled per challenge instead of
per address: five wrong guesses destroy it, which is what keeps six digits
worth using.

**Deployment target.** FastAPI in one container at `/opt/authenticator` on the
droplet, storing everything in the PostgreSQL installed on the box rather than a
Postgres of its own, with the app added to `nginx-proxy-prod` as another upstream
on a `moates.com.au` subdomain behind Cloudflare, matching how Vaultwarden is
already wired. The box runs several containers on 2GB with roughly 760MB free, so
the app is capped at 256MB and the database costs nothing extra: this is six
small tables and a few requests per device per day, not a workload. The app
reaches Postgres at `host.docker.internal`, which is how the other apps on the
box already reach the same install.

## Development

```bash
npm start            # Metro over an ngrok tunnel; scan the QR with Expo Go
npm run start:lan    # plain LAN mode, for a non-WSL machine
npm run server       # the dev sync server, on its own database
npm test             # jest, including the RFC 6238 vectors
npm run typecheck    # tsc --noEmit
```

`npm run server` is the whole local server: `/docs` on, and its own
`authenticator` database on the PostgreSQL 17 installed on Windows — found at run
time, since WSL2 reaches the Windows host by an address that changes when WSL
restarts. Verification codes are emailed here exactly as they are in production,
so it needs the SMTP credentials in `server/.env` and will not start without
them. It wants its own terminal alongside `npm start`, and the one-time role and
database setup in `server/README.md`. `uv run` syncs the environment from the
lockfile itself, so there is no install step.

A development build will not start until `EXPO_PUBLIC_SYNC_URL` names a server
in `.env`. There is no fallback to the droplet on purpose: an unset variable
would mean every account made while testing a sign-up went into the production
database alongside real ones, and the only sign of it is a hostname in small type
at the bottom of the sign-in screen. `server/README.md` covers running a dev
server against its own database, including what WSL2 needs before a phone can
reach it. Release builds have no `.env` and go to the droplet.

`npm start` uses `--tunnel` because this project is developed from WSL2, where
Metro binds to a NAT'd virtual adapter that devices on the LAN cannot reach. The
tunnel routes through ngrok instead, so the phone connects over the internet and
does not need to share a network with the host. It needs `@expo/ngrok`, which is
a dev dependency here.

Every native module in this project is either a first-party `expo-*` package or
one of the libraries Expo Go bundles (svg, screens, safe-area-context,
gesture-handler, reanimated), so Expo Go covers the whole app including camera
scanning and the keystore. There is no development-build profile for that reason:
nothing here needs one.

## Builds

Two EAS profiles, in `eas.json`:

```bash
eas build --profile internal --platform android   # APK, sideloaded
eas build --profile store --platform android      # AAB, Play Store
eas build --profile store --platform ios          # App Store
```

`internal` is Android only. An APK can be handed to a phone directly, which is
the whole point of it; iOS has no equivalent that does not go through a store or
a provisioning profile, so there is nothing to define there and the profile
leaves `ios` out rather than defining a build nobody can install.

Both are release builds — `developmentClient` is off. That matters more here than
it usually would, because it is what decides which server the app talks to.
`.env` is gitignored, EAS uploads the repository as git sees it, so no EAS build
has an `EXPO_PUBLIC_SYNC_URL` and every one of them falls through to the droplet
in `sync/sync_url.ts`. Neither profile sets that variable, deliberately: the
production URL lives in one place, and duplicating it into `eas.json` would be a
second place to forget. An internal build pointed somewhere else needs the
variable in that profile's `env` block, and it should be taken back out
afterwards.

For the same reason, do not add a `.easignore`. It replaces `.gitignore` for the
upload rather than adding to it, and the first thing that would stop being
excluded is `.env` — which is how a build ends up quietly talking to a laptop on
someone's home network.

Version codes come from EAS (`appVersionSource: "remote"`, `autoIncrement` on
each profile), so `app.json` carries the marketing `version` and nothing else.
Nothing needs bumping by hand before a build, and two builds can never collide on
a version code the Play Console has already seen.

Signing credentials are EAS-managed and generated on the first Android build.
Keep them: the Play Store will not accept an upload signed by a different key,
and losing the keystore for a published app is unrecoverable.

### Icons

Everything in `assets/` except the source is generated:

```bash
python3 scripts/make_icons.py
```

`assets/icon-source.png` is the only file to edit. It is a finished app-store
render — the padlock inside a dark squircle, on a black margin — and that shape
is the reason the others cannot just be resized copies of it. Every platform
masks the icon itself, so a baked squircle handed to iOS gets rounded twice and
ends up floating inside black corners; the script crops to the tile and fills
what the rounding left behind, so the result is full bleed and the OS does the
only rounding.

The Android layers are a different shape again. An adaptive icon is 108dp of
which only the central 66dp survives every launcher mask, so the foreground is
the padlock lifted off its tile onto transparency and scaled to fit that circle
— which is why it looks smaller than the iOS icon, and why the background is
`backgroundColor` rather than an image. The same silhouette, white, is the
monochrome layer Android 13 tints for themed icons.

The script finds the tile and the padlock by thresholding luminance rather than
by coordinates: the margin is black, the tile is very dark, the padlock is
bright. A new render can replace the source and be re-cut without touching any
numbers, provided it keeps that arrangement.

The splash is one dark screen in both themes — `#0E1014`, the same field the
artwork sits on. The glyph has a transparent centre and cyan detail that would
have nothing to hold it against on white, so a light-mode variant needs a
redesigned asset rather than a second `backgroundColor`.

## Notes

- Folders are single-depth by design. Deleting a folder moves its codes to
  Ungrouped rather than deleting them.
- Export will default to a passphrase-encrypted file. Plaintext `otpauth://`
  export will sit behind an explicit confirmation, because the OS share sheet can
  put seeds straight into iCloud or Drive.
