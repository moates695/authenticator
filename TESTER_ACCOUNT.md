# The tester account

App testers need to get into the app without an inbox. Every other account is
sent a six-digit code by email; this one address is given the same six digits
every time and is never mailed at all.

## Credentials

| | |
|---|---|
| Email | `test@app.com` |
| Passphrase | `app-tester-2026` |
| Code | `123456` |

The same three work against the local dev server and against production, so a
tester who has signed in once needs nothing else when the build they are given
changes. There is nothing to hand out beyond this table — no invite, no
allow-list, no per-tester setup.

## Using it

Sign in with the email and passphrase as normal. The app will say a code has been
sent and show the code screen; type `123456`. It behaves like a real code in
every other way — five minutes, one use, and **Send another code** issues the
same digits again.

The account already exists, so **Sign in** is the right toggle — not **Create
account**, which would be refused as a duplicate. Its vault starts empty, and
each environment has its own: codes added while testing against the dev server
are not in the production one.

## Several testers, one account

Any number of devices can be signed in at once, and every one of them derives the
same keys. Nothing in the derivation comes from the device: the Argon2id salt is
`sha256(prefix + email)` rather than a stored random value, and the data key that
actually encrypts the vault is minted once and kept on the server wrapped under
the passphrase. A device signing in for the first time re-derives the wrapping
key and unwraps its own copy. That is not a special case for this account — it is
how a real user's second phone works.

Sessions are per device. Each gets its own token and its own sliding fortnight,
and one tester signing in does not sign another out.

Three things follow from the account being shared, and they are worth telling
testers:

- **The vault is shared too.** One backup, one set of codes; anything one tester
  adds, the others see after their next sign-in. Put nothing real in it. The
  seeding script leaves an empty backup in place rather than no backup, so the
  first device to sign in pulls that instead of uploading whatever it happened to
  be holding — a device with codes already on it is asked before they are
  replaced, rather than donating them to everyone.
- **Changes move at sign-in, not continuously.** Continuous sync is not built
  yet, so two testers editing on the same day will not see each other's work
  until they sign in again, and the second push of a pair comes back as a `409`.
  For codes that only have to exist, that is invisible; it is not a fair test of
  merge behaviour, because there is not any yet.
- **Two testers signing in at the same moment collide.** The schema allows one
  live code challenge per account, so a sign-in started while another tester is
  still on the code screen destroys the first one's challenge, and that tester
  sees *"That request has expired. Start again from sign-in."* Signing in again
  works immediately — the wait in front of it is the light derivation, not the
  slow one — but it is worth knowing so it is not read as a broken build.

## Putting it on a server

```bash
npm run seed:tester                                              # the dev server
npm run seed:tester -- --url https://authenticator.moates.com.au # production
```

An account cannot simply be inserted into the database. The server holds the
data key wrapped under a key derived from the passphrase, and only a device
knows how to make one — a row put in by hand would be an account nobody could
open, and it would fail at the end of a sign-in rather than the start. So
`scripts/seed_tester_account.mjs` does what the app does: derives both keys from
the passphrase in the table above, mints and wraps a data key, and registers over
the real API with the fixed code standing in for the email. It then signs in
again and unwraps what the server gave back, so a run that prints `Checked` has
proved the account works rather than merely created rows.

Every constant it needs is read out of `src/sync/keys.ts` and
`src/vault/envelope.ts` as it runs, and the KDF parameters come from
`/v1/prelogin`, so it stops with a message if the app's key hierarchy moves
underneath it. It is safe to run twice: an account that is already there is left
alone unless `--recreate` is passed.

The recovery key it prints is real but disposable — nothing here depends on
keeping it, and a re-seed mints another.

## What it is and is not

It is a fixed second factor, not a bypass. The passphrase is checked exactly as
it is for everyone else — a wrong one gets a `401` and no challenge at all — so
this is an account with one real factor rather than an open door. A wrong code is
still refused, and the fixed code opens nothing but this address: sent against
anyone else's challenge it is simply a wrong guess.

The exception is deliberately narrow, in four ways:

- **One address, named in full.** `TEST_ACCOUNT_EMAIL` holds a single address,
  compared exactly. It is not a pattern, a domain or a boolean, so it cannot be
  widened by a careless edit — a second tester account would take a code change.
- **The digits are not configuration.** `TEST_ACCOUNT_CODE` is a constant in
  `server/app/config.py`. A deployment can decide *which* address is exempt, but
  not what the exemption is, so the environment cannot hold a quiet exception
  with a less obvious code in it.
- **The throttles that matter still apply.** The code-send limits are skipped —
  they exist to protect somebody's inbox, and no message is sent here — but the
  failed-login throttle, the attempt cap on wrong codes, and the session rules
  are all unchanged.
- **It is tested.** `server/tests/test_api.py` covers registration and sign-in
  with the fixed code, that a wrong passphrase and a wrong code are still
  refused, that the fixed code opens no other account, and that the address is
  ordinary on a server which has not configured it.

What it costs is real and worth stating plainly: anyone who reads this file can
sign in as `test@app.com` on production if they also know the passphrase, which
is in the table above. So the account is worth exactly what is in it — put no
real TOTP secrets in it, and assume anything synced to it is public. It is safe
to leave enabled because it holds nothing, not because it is hard to reach.

This is the same trade the old `EMAIL_CONSOLE=1` lost: that setting made *every*
account's second factor optional, on any environment, with no test that would
have noticed. See "Local development" in `server/README.md`.

## How it is switched on

One environment variable, on the server, in both environments:

```bash
TEST_ACCOUNT_EMAIL=test@app.com
```

- **Local.** Already in `server/.env`, so `npm run server` picks it up. New
  clones get it from `server/.env.example` when they copy it.
- **Production.** The same line in `server/.env` on the droplet, then
  `docker compose up -d --force-recreate authenticator` to restart the container
  with it. The variable arrives through `env_file`, so nothing in
  `docker-compose.yml` changes.

Leaving it unset — the default — means there is no tester account and every
address is mailed a random code. That is what the test suite runs with.

## Retiring it

When the app no longer needs testers on it:

1. Remove `TEST_ACCOUNT_EMAIL` from `server/.env` on the droplet and recreate the
   container. The address becomes ordinary again immediately — an outstanding
   challenge for it stops accepting `123456` on the next request, and a sign-in
   from then on is mailed a real code to an inbox nobody has.
2. Delete the account, which also drops its vault and any live sessions through
   `ON DELETE CASCADE`. The seeding script cannot do this on its own — it deletes
   only as the first half of `--recreate` — and the app has `Sign out` and
   nothing further, so it is a query on the droplet:

   ```bash
   sudo -u postgres psql -d authenticator \
     -c "DELETE FROM users WHERE email = 'test@app.com'"
   ```

   Locally the same statement against the dev database does it.

Changing the passphrase is an edit to the table at the top of this file followed
by `npm run seed:tester -- --recreate` against each environment: the script signs
in with the old passphrase, deletes the account, and makes it again with the new
one. It is a recreation rather than a change because `/v1/keys` re-wraps the data
key under a new passphrase but nothing in the app calls it yet — so whatever was
in the vault goes with the old account, which for this one is the point. Changing
the address is the same, plus editing `TEST_ACCOUNT_EMAIL` in both environments.
