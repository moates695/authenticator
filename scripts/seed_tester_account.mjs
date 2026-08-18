/**
 * Creates the tester account on a sync server, so testers find it already there
 * rather than having to create it themselves on every environment.
 *
 * Run `node scripts/seed_tester_account.mjs` against the dev server, or pass
 * `--url https://authenticator.moates.com.au` for production. The address,
 * passphrase and code come from the table in TESTER_ACCOUNT.md, which stays the
 * one place they are written down.
 *
 * The account cannot simply be inserted into the database: the server stores the
 * data key wrapped under a key derived from the passphrase, and only the device
 * knows how to make one. So this does what the app does — derives both keys,
 * mints a data key, wraps it twice — and registers over the real API, with the
 * server's fixed code standing in for the email that never arrives.
 *
 * It is not a second implementation of the key hierarchy. Every constant it
 * needs is read out of src/sync/keys.ts and src/vault/envelope.ts at run time
 * and the parameters come from `/v1/prelogin`, so a change on either side stops
 * this script rather than silently seeding an account nobody can open. The
 * derivation itself is four library calls; the checks at the end unwrap what was
 * stored, which is the thing that actually has to work.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { argon2idAsync } from '@noble/hashes/argon2.js';
import { expand } from '@noble/hashes/hkdf.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const DEFAULT_URL = 'http://127.0.0.1:8000';

// --- what the app says these are -----------------------------------------

/**
 * Pulls a literal out of a source file, the way src/sync/keys.test.ts reads the
 * server's KDF parameters. A miss is fatal: it means the app has moved and this
 * script would otherwise derive keys from a stale copy of a constant.
 */
function literal(file, pattern, name) {
  const source = readFileSync(join(ROOT, file), 'utf8');
  const match = pattern.exec(source);
  if (!match) {
    throw new Error(
      `${name} is no longer where this script looks for it in ${file}.\n` +
        'Check what it is now and update the pattern here — the account this ' +
        'would create otherwise could not be opened by the app.',
    );
  }
  return match[1];
}

const KEYS = 'src/sync/keys.ts';
const ENVELOPE = 'src/vault/envelope.ts';

const ENCRYPTION_SALT_PREFIX = literal(
  KEYS,
  /^const ENCRYPTION_SALT_PREFIX = '(.*)';$/m,
  'ENCRYPTION_SALT_PREFIX',
);
const AUTH_SALT_PREFIX = literal(KEYS, /^const AUTH_SALT_PREFIX = '(.*)';$/m, 'AUTH_SALT_PREFIX');
const RECOVERY_INFO = literal(KEYS, /^const RECOVERY_INFO = '(.*)';$/m, 'RECOVERY_INFO');
const BASE32_ALPHABET = literal(KEYS, /^const BASE32_ALPHABET = '(.*)';$/m, 'BASE32_ALPHABET');
const RECOVERY_KEY_BYTES = Number(
  literal(KEYS, /^export const RECOVERY_KEY_BYTES = (\d+);$/m, 'RECOVERY_KEY_BYTES'),
);
const ENVELOPE_VERSION = Number(
  literal(ENVELOPE, /^export const ENVELOPE_VERSION = (\d+);$/m, 'ENVELOPE_VERSION'),
);
const NONCE_BYTES = Number(
  literal(ENVELOPE, /^export const NONCE_BYTES = (\d+);$/m, 'NONCE_BYTES'),
);
const KEY_BYTES = Number(literal(ENVELOPE, /^export const KEY_BYTES = (\d+);$/m, 'KEY_BYTES'));
const SCHEMA_VERSION = Number(
  literal('src/vault/types.ts', /^ {4}schema_version: (\d+),$/m, "emptyVault's schema_version"),
);

/**
 * The credentials, read out of the table in TESTER_ACCOUNT.md so that the doc a
 * tester is handed and the account that exists cannot disagree.
 */
function credentials() {
  const doc = readFileSync(join(ROOT, 'TESTER_ACCOUNT.md'), 'utf8');
  const cell = (label) => {
    const match = new RegExp(`^\\| ${label} \\| \`(.+?)\` \\|$`, 'm').exec(doc);
    if (!match) throw new Error(`No "${label}" row in the credentials table in TESTER_ACCOUNT.md`);
    return match[1];
  };
  return { email: cell('Email'), passphrase: cell('Passphrase'), code: cell('Code') };
}

// --- the app's key hierarchy, in four library calls -----------------------

// Whichever algorithm `/v1/prelogin` names, since the two derivations are not
// on the same one and an account seeded before the switch is still on Argon2id.
// The branch mirrors `stretch` in src/sync/keys.ts; see there for why.
const stretch = (passphrase, salt, kdf) => {
  const password = utf8ToBytes(passphrase.normalize('NFKC'));
  if (kdf.algorithm === 'scrypt') {
    return scryptAsync(password, salt, {
      N: (kdf.memory_kib * 1024) / (128 * kdf.block_size),
      r: kdf.block_size,
      p: kdf.parallelism,
      dkLen: KEY_BYTES,
    });
  }
  if (kdf.algorithm === 'argon2id') {
    return argon2idAsync(password, salt, {
      t: kdf.iterations,
      m: kdf.memory_kib,
      p: kdf.parallelism,
      dkLen: KEY_BYTES,
    });
  }
  throw new Error(`This script cannot derive keys with ${kdf.algorithm}.`);
};

const deriveAuthKey = (passphrase, email, kdf) =>
  stretch(passphrase, sha256(utf8ToBytes(`${AUTH_SALT_PREFIX}${email}`)), kdf);

const deriveEncryptionKey = (passphrase, email, kdf) =>
  stretch(passphrase, sha256(utf8ToBytes(`${ENCRYPTION_SALT_PREFIX}${email}`)), kdf);

function seal(plaintext, key) {
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(plaintext);
  const out = new Uint8Array(1 + NONCE_BYTES + ciphertext.length);
  out[0] = ENVELOPE_VERSION;
  out.set(nonce, 1);
  out.set(ciphertext, 1 + NONCE_BYTES);
  return out;
}

function unseal(blob, key) {
  if (blob[0] !== ENVELOPE_VERSION) throw new Error(`Unsupported envelope version ${blob[0]}`);
  return xchacha20poly1305(key, blob.subarray(1, 1 + NONCE_BYTES)).decrypt(
    blob.subarray(1 + NONCE_BYTES),
  );
}

/** Crockford's base32, grouped in fours, exactly as the app shows it. */
function generateRecoveryKey() {
  let out = '';
  let accumulator = 0;
  let bits = 0;
  for (const byte of randomBytes(RECOVERY_KEY_BYTES)) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(accumulator >> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(accumulator << (5 - bits)) & 31];
  return (out.match(/.{1,4}/g) ?? []).join('-');
}

const recoveryWrappingKey = (text) =>
  expand(sha256, utf8ToBytes(text.replace(/[^0-9A-Z]/g, '')), utf8ToBytes(RECOVERY_INFO), KEY_BYTES);

/**
 * The empty vault, in the exact shape `emptyVault()` returns and sealed the way
 * `encryptVault` seals it — the same bytes a device would have written.
 */
function emptyVaultBlob(dataKey) {
  const vault = {
    schema_version: SCHEMA_VERSION,
    folders: [],
    entries: [],
    tombstones: [],
    updated_at: Date.now(),
  };
  return seal(utf8ToBytes(JSON.stringify(vault)), dataKey);
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const bytes = (base64) => new Uint8Array(Buffer.from(base64, 'base64'));

// --- the API ---------------------------------------------------------------

async function call(url, path, body) {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(`POST ${path} → ${response.status}: ${text}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

/** `call`, for the endpoints that want a session as well as a body. */
async function authed(url, method, path, token, body) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

/** Field-by-field, since these have been through JSON on the way here. */
function sameParams(a, b) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.every((key) => a[key] === b[key]);
}

/**
 * The parameters the server hands a device for an address it has never seen,
 * which are its current defaults. `/v1/prelogin` answers identically whether or
 * not the account exists — that is what stops it being used to enumerate
 * accounts — so asking about an address nobody has registered is a sound way to
 * read the defaults, and there is no second endpoint that gives them.
 *
 * example.com rather than a reserved suffix like .invalid, which the server's
 * email validation rejects outright. Thirty-two hex characters in front of it
 * is not an address anyone has registered.
 */
function serverDefaults(url) {
  return call(url, '/v1/prelogin', { email: `${randomBytes(16).toString('hex')}@example.com` });
}

/**
 * Both factors, with the fixed code standing in for the emailed one. Returns the
 * session body, whose wrapped keys are what the app would unwrap on a new
 * device.
 */
async function signIn(url, { email, passphrase, code }, authKdf) {
  const authKey = await deriveAuthKey(passphrase, email, authKdf);
  const challenge = await call(url, '/v1/login', { email, auth_key: b64(authKey) });
  return call(url, '/v1/verify', { challenge_id: challenge.challenge_id, code });
}

/**
 * Moves an account that already exists onto the server's current derivation
 * parameters, without changing the passphrase and without touching the vault.
 *
 * The same thing `upgradeStoredKdf` in src/sync/account.tsx does when a tester
 * signs in, done here so an environment can be brought forward deliberately
 * rather than waiting for someone to happen to sign in. It has to be a client:
 * what the parameters protect is the data key wrapped under a key derived from
 * the passphrase, and the server has never held either.
 *
 * Only the passphrase wrapping is rebuilt. The recovery wrapping goes back up
 * byte for byte — no KDF runs on that side, so there is nothing there to be out
 * of date — and so do the auth key and its parameters, since this is not a
 * passphrase change and declaring parameters the stored key was not made under
 * would lock the account out of `/v1/login`.
 */
async function upgradeExisting(url, { email, passphrase, code }, authKdf) {
  const { kdf: target } = await serverDefaults(url);

  const session = await signIn(url, { email, passphrase, code }, authKdf);
  if (sameParams(session.kdf, target)) {
    console.log(`Parameters  already ${describeKdf(target)}; nothing to do`);
    return;
  }
  console.log(`Parameters  ${describeKdf(session.kdf)} → ${describeKdf(target)}`);

  // Open it with what it was made under, which is the only thing that can.
  const dataKey = unseal(
    bytes(session.wrapped_passphrase),
    await deriveEncryptionKey(passphrase, email, session.kdf),
  );
  const wrappedPassphrase = seal(dataKey, await deriveEncryptionKey(passphrase, email, target));
  const authKey = await deriveAuthKey(passphrase, email, authKdf);

  await authed(url, 'PUT', '/v1/keys', session.token, {
    current_auth_key: b64(authKey),
    new_auth_key: b64(authKey),
    kdf: target,
    auth_kdf: authKdf,
    wrapped_passphrase: b64(wrappedPassphrase),
    wrapped_recovery: session.wrapped_recovery,
  });
  console.log('Re-wrapped  the data key under the new parameters');

  // The check that matters: sign in as a device that has never seen the
  // account and open what came back. A re-wrap that stored something the new
  // parameters do not reproduce would fail here rather than in a tester's hands.
  const back = await signIn(url, { email, passphrase, code }, authKdf);
  if (!sameParams(back.kdf, target)) throw new Error('The server did not keep the new parameters');
  const reopened = unseal(
    bytes(back.wrapped_passphrase),
    await deriveEncryptionKey(passphrase, email, target),
  );
  if (b64(reopened) !== b64(dataKey)) throw new Error('The re-wrapped data key did not come back');

  const stored = await fetch(`${url}/v1/vault`, {
    headers: { Authorization: `Bearer ${back.token}` },
  }).then((response) => response.json());
  if (stored.ciphertext) {
    JSON.parse(Buffer.from(unseal(bytes(stored.ciphertext), reopened)).toString());
  }
  console.log('Checked     signed in again, unwrapped the data key, opened the vault');
}

function describeKdf(kdf) {
  const cost = kdf.algorithm === 'argon2id' ? `t=${kdf.iterations}` : `r=${kdf.block_size}`;
  return `${kdf.algorithm} ${kdf.memory_kib / 1024}MiB ${cost}`;
}

async function main() {
  const args = process.argv.slice(2);
  const url = (valueOf(args, '--url') ?? DEFAULT_URL).replace(/\/$/, '');
  const recreate = args.includes('--recreate');

  const { email, passphrase, code } = credentials();
  console.log(`Server      ${url}`);
  console.log(`Account     ${email}`);

  // The parameters the server hands a device that has never seen this account.
  // Taken from it rather than copied from the app, so a raise on either side is
  // picked up here; src/sync/keys.test.ts is what holds the two in step.
  const { kdf, auth_kdf: authKdf } = await call(url, '/v1/prelogin', { email });

  if (recreate) {
    const existing = await signIn(url, { email, passphrase, code }, authKdf).catch((err) => {
      if (err.status === 401) return null; // Nothing there, or a different passphrase.
      throw err;
    });
    if (existing) {
      const authKey = await deriveAuthKey(passphrase, email, authKdf);
      await fetch(`${url}/v1/account/delete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${existing.token}`,
        },
        body: JSON.stringify({ auth_key: b64(authKey) }),
      });
      console.log('Removed     the account that was there, with its vault');
    }
  }

  const challenge = await call(url, '/v1/register', { email }).catch(async (err) => {
    if (err.status === 409) {
      // Already there, so the job is to bring it forward rather than to make
      // it. Re-creating would work too and would throw the vault away with it;
      // this is what a real account gets, so it is what the tester gets.
      console.log('\nThe account already exists on this server.');
      await upgradeExisting(url, { email, passphrase, code }, authKdf);
      console.log('\nPass --recreate to delete it and make it again instead.');
      process.exit(0);
    }
    throw err;
  });
  if (challenge.purpose !== 'register') throw new Error(`Unexpected challenge ${challenge.purpose}`);

  const authKey = await deriveAuthKey(passphrase, email, authKdf);
  const encryptionKey = await deriveEncryptionKey(passphrase, email, kdf);
  const dataKey = new Uint8Array(randomBytes(KEY_BYTES));
  const recoveryKey = generateRecoveryKey();

  const created = await call(url, '/v1/verify', {
    challenge_id: challenge.challenge_id,
    code,
    auth_key: b64(authKey),
    kdf,
    auth_kdf: authKdf,
    wrapped_passphrase: b64(seal(dataKey, encryptionKey)),
    wrapped_recovery: b64(seal(dataKey, recoveryWrappingKey(recoveryKey))),
  }).catch((err) => {
    if (err.status === 401) {
      throw new Error(
        `The server would not take ${code} as the code. TEST_ACCOUNT_EMAIL is ` +
          `probably not set to ${email} there — see TESTER_ACCOUNT.md.`,
      );
    }
    throw err;
  });
  console.log(`Created     user ${created.user_id}, vault version ${created.vault_version}`);

  // An empty backup, rather than leaving the vault NULL. It matters more here
  // than for a normal account: the app treats an account with no backup as one
  // that should adopt whatever the device already holds, so the first tester to
  // sign in would silently upload their own codes into an account everyone
  // else can open. With a real backup in place, a device with codes on it is
  // asked before they are replaced instead.
  await fetch(`${url}/v1/vault`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${created.token}`,
    },
    body: JSON.stringify({
      base_version: created.vault_version,
      ciphertext: b64(emptyVaultBlob(dataKey)),
    }),
  }).then(async (response) => {
    if (!response.ok) throw new Error(`PUT /v1/vault → ${response.status}: ${await response.text()}`);
  });
  console.log('Backed up   an empty vault, so no device is asked to donate its codes');

  // The point of the exercise: sign in as the app would, on a device that has
  // never seen the account, and open what came back. An account whose wrapped
  // key does not unwrap is worse than no account at all — it fails after the
  // passphrase, the code and the derivation, where the message is least useful.
  const session = await signIn(url, { email, passphrase, code }, authKdf);
  const unwrapped = unseal(bytes(session.wrapped_passphrase), encryptionKey);
  if (b64(unwrapped) !== b64(dataKey)) throw new Error('The stored data key did not come back');
  const fromRecovery = unseal(bytes(session.wrapped_recovery), recoveryWrappingKey(recoveryKey));
  if (b64(fromRecovery) !== b64(dataKey)) throw new Error('The recovery copy did not come back');

  const stored = await fetch(`${url}/v1/vault`, {
    headers: { Authorization: `Bearer ${session.token}` },
  }).then((response) => response.json());
  const vault = JSON.parse(Buffer.from(unseal(bytes(stored.ciphertext), unwrapped)).toString());
  if (vault.entries.length !== 0) throw new Error('The seeded vault is not empty');
  console.log('Checked     signed in again, unwrapped the data key both ways, opened the vault');

  console.log(`\nSign in with the passphrase and code in TESTER_ACCOUNT.md.`);
  console.log(`Recovery key (nothing depends on keeping it): ${recoveryKey}`);
}

function valueOf(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
