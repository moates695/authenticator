import { argon2idAsync } from '@noble/hashes/argon2.js';
import { expand } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import * as Crypto from 'expo-crypto';

import { KEY_BYTES, seal, unseal } from '@/vault/envelope';
import { normaliseEmail } from './account_policy';
import { YIELD_BUDGET_MS, installEventLoopYield } from './js_thread';

/**
 * The key hierarchy behind the sync account.
 *
 *   passphrase ─┬─Argon2id(AUTH_KDF, 8MiB)──> auth key ──> the server (which
 *               │                                          only ever sees a
 *               │                                          scrypt digest of it)
 *               └─Argon2id(DEFAULT_KDF, 32MiB)──> encryption key ──┐
 *                                                                  │ unwraps
 *   random 32 bytes ──────────────────────────> data key <─────────┘
 *                                                   │ encrypts
 *                                                   └──> the vault, on disk and
 *                                                        on the server
 *
 * Two derivations rather than one split in half, because the two are wanted at
 * different moments. Signing in sends the auth key to `/v1/login` before a code
 * goes out — no code is sent to an address whose passphrase was wrong — and only
 * derives the encryption key once that code has come back. A single pass would
 * put all of its cost in front of the code; splitting it puts the light half
 * there and the heavy half after, where the user is already through the door.
 *
 * The two are independent: different salts, different parameters, and neither is
 * derivable from the other. What the split costs is that an attacker holding the
 * server's database can test a guessed passphrase against the auth key's digest
 * for less than the encryption key would have charged them — see
 * server/app/crypto.py, whose scrypt parameters are set to carry that.
 *
 * The encryption key never leaves the device, so the server holds ciphertext it
 * cannot open. The indirection through a data key is what makes a passphrase
 * change cheap — only the 32-byte data key is re-wrapped, never the vault — and
 * what makes a second, independent way in possible: the same data key is also
 * wrapped under a recovery key, for the day the passphrase is forgotten.
 */

export type KdfParams = {
  algorithm: 'argon2id';
  /** Memory cost in kibibytes. */
  memory_kib: number;
  iterations: number;
  parallelism: number;
};

/**
 * Tuned for pure-JS Argon2id under Hermes, which is perhaps an order of
 * magnitude slower than the native builds these numbers usually assume. 32MiB
 * with four passes stays firmly memory-hard while keeping an unlock to a wait
 * the progress bar can explain.
 *
 * These are stored per account and handed back by `/v1/prelogin`, so raising
 * them later is a client-side change that leaves existing accounts working on
 * their old parameters until they next change their passphrase.
 *
 * They must stay in step with `DEFAULT_KDF` in server/app/config.py, which is
 * what `/v1/prelogin` answers with for an address it has never seen. If the two
 * drift, that answer tells a stranger whether the account exists.
 */
export const DEFAULT_KDF: KdfParams = {
  algorithm: 'argon2id',
  memory_kib: 32768,
  iterations: 4,
  parallelism: 1,
};

/**
 * The auth key's own parameters, deliberately a fraction of the above.
 *
 * This one runs before the code can be asked for, so its cost is a wait with
 * nothing on screen to show for it; a quarter of a second is what that can be
 * without the sign-in button feeling stuck. It is not what protects the vault —
 * `DEFAULT_KDF` is — and the server's scrypt over the result is what stands
 * behind it if the database is ever taken.
 *
 * Stored per account like the other set, handed back by `/v1/prelogin`, and
 * matched by `DEFAULT_AUTH_KDF` in server/app/config.py.
 */
export const AUTH_KDF: KdfParams = {
  algorithm: 'argon2id',
  memory_kib: 8192,
  iterations: 1,
  parallelism: 1,
};

/**
 * How long a derivation may hold the JS thread before yielding, in ms.
 *
 * The same budget the yield itself throttles to. noble's own accounting charges
 * the pause to the block that follows it, so a figure below what a pause costs
 * on the device puts every block over budget and pauses after each one — see
 * `js_thread.ts`, which is where that is contained rather than tuned around.
 */
const ASYNC_TICK_MS = YIELD_BUDGET_MS;

/**
 * Reports progress only when the number on screen would change.
 *
 * noble calls back about ten thousand times across a derivation, aimed at a
 * progress bar on an 8K display. The button shows whole percent, so ninety-nine
 * in every hundred of those are a re-render of the whole form with nothing new
 * in it — and they land in the middle of the one stretch where the JS thread is
 * already the scarce resource.
 */
function wholePercent(onProgress: (fraction: number) => void): (fraction: number) => void {
  let last = -1;
  return (fraction) => {
    const percent = Math.round(fraction * 100);
    if (percent === last) return;
    last = percent;
    onProgress(percent / 100);
  };
}

const RECOVERY_INFO = 'authenticator:recovery-key:v1';
const ENCRYPTION_SALT_PREFIX = 'authenticator:kdf-salt:v1:';
const AUTH_SALT_PREFIX = 'authenticator:auth-salt:v1:';

/**
 * The Argon2id salt, derived from the email rather than stored.
 *
 * A per-account random salt would have to be handed out before the user has
 * proved anything, which turns `/v1/prelogin` into an account oracle. Deriving
 * it from the address instead keeps that endpoint answerable for any input.
 * The prefix domain-separates it from any other use of the same address — and,
 * since the two derivations differ by prefix, from each other: the same
 * passphrase and address give the auth key and the encryption key nothing in
 * common, so neither can be worked out from the other.
 */
export function kdfSalt(email: string): Uint8Array {
  return sha256(utf8ToBytes(`${ENCRYPTION_SALT_PREFIX}${normaliseEmail(email)}`));
}

export function authKdfSalt(email: string): Uint8Array {
  return sha256(utf8ToBytes(`${AUTH_SALT_PREFIX}${normaliseEmail(email)}`));
}

/**
 * Stretches the passphrase into 32 bytes, under whichever salt and parameters
 * the caller is after. The two exported derivations below are the callers.
 *
 * NFKC-normalised first, so a passphrase typed with a composed accent on one
 * device and a decomposed one on another still derives the same key.
 *
 * @param onProgress called with 0..1 while the derivation runs.
 */
async function stretch(
  passphrase: string,
  salt: Uint8Array,
  kdf: KdfParams,
  onProgress?: (fraction: number) => void,
): Promise<Uint8Array> {
  // Without this the derivation holds the JS thread from the first block to the
  // last, and the progress below is reported to a screen that cannot repaint.
  // It cannot fail in a bundle built through babel.config.js, whose alias is
  // what puts the yield in place — a false here means that alias is gone, and
  // in development that should be a loud stop rather than a frozen phone.
  if (!installEventLoopYield() && __DEV__) {
    throw new Error(
      'The event-loop yield is not installed, so this derivation would freeze the app. ' +
        'Check the @noble/hashes/utils.js alias in babel.config.js.',
    );
  }

  return argon2idAsync(utf8ToBytes(passphrase.normalize('NFKC')), salt, {
    t: kdf.iterations,
    m: kdf.memory_kib,
    p: kdf.parallelism,
    dkLen: KEY_BYTES,
    asyncTick: ASYNC_TICK_MS,
    onProgress: onProgress && wholePercent(onProgress),
  });
}

/**
 * The key the server checks. Sent to `/v1/login` before it will email a code,
 * and to `/v1/keys` and `/v1/account/delete` as proof of the passphrase.
 *
 * Light enough to run while a button is held down — see `AUTH_KDF` — so no
 * progress callback: there is nothing worth reporting in a quarter of a second.
 */
export function deriveAuthKey(
  passphrase: string,
  email: string,
  kdf: KdfParams = AUTH_KDF,
): Promise<Uint8Array> {
  return stretch(passphrase, authKdfSalt(email), kdf);
}

/**
 * The key that unwraps the data key, and the slow one. Never sent anywhere.
 *
 * @param onProgress called with 0..1 while the derivation runs.
 */
export function deriveEncryptionKey(
  passphrase: string,
  email: string,
  kdf: KdfParams = DEFAULT_KDF,
  onProgress?: (fraction: number) => void,
): Promise<Uint8Array> {
  return stretch(passphrase, kdfSalt(email), kdf, onProgress);
}

/** Mints the data key that actually encrypts the vault. */
export function generateDataKey(): Uint8Array {
  return Crypto.getRandomBytes(KEY_BYTES);
}

export function wrapDataKey(dataKey: Uint8Array, wrappingKey: Uint8Array): Uint8Array {
  if (dataKey.length !== KEY_BYTES) {
    throw new Error(`Data key must be ${KEY_BYTES} bytes, got ${dataKey.length}`);
  }
  return seal(dataKey, wrappingKey);
}

/** Throws if the wrapping key is wrong, or if what came back is not a key. */
export function unwrapDataKey(blob: Uint8Array, wrappingKey: Uint8Array): Uint8Array {
  const key = unseal(blob, wrappingKey);
  if (key.length !== KEY_BYTES) {
    throw new Error(`Unwrapped data key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return key;
}

// --- Recovery keys -------------------------------------------------------

/**
 * Crockford's base32: no I, L, O or U, so there is no 1/I or 0/O ambiguity to
 * resolve when someone reads a recovery key back off a piece of paper, and no
 * accidental words to alarm them.
 */
const BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 160 bits — far beyond guessing, and exactly 32 characters with no padding. */
export const RECOVERY_KEY_BYTES = 20;
const RECOVERY_GROUP_SIZE = 4;

function bytesToBase32(bytes: Uint8Array): string {
  let out = '';
  let accumulator = 0;
  let bits = 0;

  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(accumulator >> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(accumulator << (5 - bits)) & 31];

  return out;
}

/**
 * Cleans up a hand-typed recovery key: drops the spacing and hyphens people add
 * back, uppercases, and folds the letters Crockford's alphabet leaves out onto
 * the digits they get mistaken for.
 */
export function normaliseRecoveryKey(text: string): string {
  return text
    .toUpperCase()
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/[^0-9A-Z]/g, '');
}

/** Groups the key for display, which is how it is meant to be written down. */
export function formatRecoveryKey(key: string): string {
  return (key.match(new RegExp(`.{1,${RECOVERY_GROUP_SIZE}}`, 'g')) ?? []).join('-');
}

export function generateRecoveryKey(): string {
  return formatRecoveryKey(bytesToBase32(Crypto.getRandomBytes(RECOVERY_KEY_BYTES)));
}

/**
 * Turns a recovery key into the 32-byte key that wraps the data key.
 *
 * No Argon2 pass here: unlike a passphrase this is 160 bits of machine-chosen
 * randomness, so there is nothing for a slow KDF to defend against.
 *
 * @throws if the key is the wrong length or has characters outside the alphabet.
 */
export function recoveryWrappingKey(text: string): Uint8Array {
  const normalised = normaliseRecoveryKey(text);
  const expected = Math.ceil((RECOVERY_KEY_BYTES * 8) / 5);

  if (normalised.length !== expected) {
    throw new Error(`Recovery key must be ${expected} characters, got ${normalised.length}`);
  }
  for (const character of normalised) {
    if (!BASE32_ALPHABET.includes(character)) {
      throw new Error(`Recovery key contains ${JSON.stringify(character)}, which is not part of it`);
    }
  }

  return expand(sha256, utf8ToBytes(normalised), utf8ToBytes(RECOVERY_INFO), KEY_BYTES);
}
