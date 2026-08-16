import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { equalBytes } from '@noble/ciphers/utils.js';

import {
  AUTH_KDF,
  DEFAULT_KDF,
  RECOVERY_KEY_BYTES,
  authKdfSalt,
  deriveAuthKey,
  deriveEncryptionKey,
  formatRecoveryKey,
  generateDataKey,
  generateRecoveryKey,
  kdfSalt,
  normaliseRecoveryKey,
  recoveryWrappingKey,
  unwrapDataKey,
  wrapDataKey,
  type KdfParams,
} from './keys';

/** Argon2id is slow on purpose. These stand in for it where only the wiring is under test. */
const FAST_KDF: KdfParams = { algorithm: 'argon2id', memory_kib: 256, iterations: 1, parallelism: 1 };

const EMAIL = 'me@example.com';
const PASSPHRASE = 'correct horse battery staple';

/**
 * Reads a parameter block out of the server's config, so the two sides can be
 * compared rather than trusted to have been changed together.
 *
 * Both are declared there as plain dicts of strings and integers, which is JSON
 * once the type annotation is off — no Python needed to read them.
 */
function serverDefault(name: string): KdfParams {
  const source = readFileSync(join(__dirname, '../../server/app/config.py'), 'utf8');
  const block = new RegExp(`^${name}[^=]*= (\\{[^}]*\\})`, 'm').exec(source);
  if (!block) throw new Error(`${name} is not in server/app/config.py, or no longer a dict literal`);
  return JSON.parse(block[1].replace(/,(\s*})/, '$1')) as KdfParams;
}

describe('kdf parameters', () => {
  // server/app/schemas.py: memory 8192..1048576, iterations 1..32, parallelism 1..16.
  it.each([
    ['the encryption key', DEFAULT_KDF],
    ['the auth key', AUTH_KDF],
  ])('stays inside the bounds the server will accept for %s', (_name, kdf) => {
    expect(kdf.memory_kib).toBeGreaterThanOrEqual(8192);
    expect(kdf.memory_kib).toBeLessThanOrEqual(1024 * 1024);
    expect(kdf.iterations).toBeGreaterThanOrEqual(1);
    expect(kdf.iterations).toBeLessThanOrEqual(32);
    expect(kdf.parallelism).toBeGreaterThanOrEqual(1);
    expect(kdf.parallelism).toBeLessThanOrEqual(16);
  });

  it.each([
    ['DEFAULT_KDF', DEFAULT_KDF],
    ['DEFAULT_AUTH_KDF', AUTH_KDF],
  ])('matches %s in server/app/config.py', (name, ours) => {
    // `/v1/prelogin` answers for an unknown address with the server's copy, so
    // a drift between the two tells a stranger whether an account exists. The
    // auth parameters have a second, louder failure: derive that key on numbers
    // the account was not made with and `/v1/login` reads it as a wrong
    // passphrase, so every sign-in stops working.
    expect(ours).toEqual(serverDefault(name));
  });

  it('keeps the auth key’s pass the cheaper of the two', () => {
    // The auth key is derived in front of the code being sent, the encryption
    // key after it comes back. Inverted, the sign-in screen would be holding
    // the user up for the wrong one.
    const work = (kdf: KdfParams) => kdf.memory_kib * kdf.iterations;
    expect(work(AUTH_KDF)).toBeLessThan(work(DEFAULT_KDF));
  });
});

describe('kdf salt', () => {
  it('is the same for the same address however it was typed', () => {
    expect(Array.from(kdfSalt('  Me@Example.COM '))).toEqual(Array.from(kdfSalt(EMAIL)));
    expect(Array.from(authKdfSalt('  Me@Example.COM '))).toEqual(Array.from(authKdfSalt(EMAIL)));
  });

  it('differs between addresses', () => {
    expect(equalBytes(kdfSalt(EMAIL), kdfSalt('other@example.com'))).toBe(false);
    expect(equalBytes(authKdfSalt(EMAIL), authKdfSalt('other@example.com'))).toBe(false);
  });

  it('differs between the two derivations, so neither leads to the other', () => {
    expect(equalBytes(kdfSalt(EMAIL), authKdfSalt(EMAIL))).toBe(false);
  });

  it('is 32 bytes, comfortably over Argon2id’s minimum', () => {
    expect(kdfSalt(EMAIL)).toHaveLength(32);
  });
});

describe('key derivation', () => {
  it('is deterministic for the same passphrase, address and parameters', async () => {
    const [a, b] = await Promise.all([
      deriveEncryptionKey(PASSPHRASE, EMAIL, FAST_KDF),
      deriveEncryptionKey(PASSPHRASE, EMAIL, FAST_KDF),
    ]);
    expect(equalBytes(a, b)).toBe(true);
  });

  it('changes with the passphrase', async () => {
    const a = await deriveEncryptionKey(PASSPHRASE, EMAIL, FAST_KDF);
    const b = await deriveEncryptionKey(`${PASSPHRASE}!`, EMAIL, FAST_KDF);
    expect(equalBytes(a, b)).toBe(false);
  });

  it('changes with the address, so two accounts never share a key', async () => {
    const a = await deriveEncryptionKey(PASSPHRASE, EMAIL, FAST_KDF);
    const b = await deriveEncryptionKey(PASSPHRASE, 'other@example.com', FAST_KDF);
    expect(equalBytes(a, b)).toBe(false);
  });

  it('normalises the passphrase, so a composed accent matches a decomposed one', async () => {
    // U+00E9 against 'e' + U+0301: the same word, two encodings, one key.
    const composed = await deriveEncryptionKey('café passphrase', EMAIL, FAST_KDF);
    const decomposed = await deriveEncryptionKey('café passphrase', EMAIL, FAST_KDF);
    expect(equalBytes(composed, decomposed)).toBe(true);
  });

  it('gives the JS thread back on the way through, so the app can repaint', async () => {
    // FAST_KDF is over inside a single tick, so it never has to yield at all.
    // This one runs long enough to have to, which is the case that matters: a
    // derivation that holds the thread start to finish takes the progress bar,
    // the touch handling and eventually the app down with it.
    const slow: KdfParams = {
      algorithm: 'argon2id',
      memory_kib: 8192,
      iterations: 2,
      parallelism: 1,
    };
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 5);

    try {
      await deriveEncryptionKey(PASSPHRASE, EMAIL, slow);
    } finally {
      clearInterval(timer);
    }

    expect(ticks).toBeGreaterThan(0);
  });

  it('reports progress on the way through', async () => {
    const seen: number[] = [];
    await deriveEncryptionKey(PASSPHRASE, EMAIL, FAST_KDF, (fraction) => seen.push(fraction));
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...seen)).toBeLessThanOrEqual(1);
  });
});

describe('the two derivations against each other', () => {
  it('gives two unrelated 32-byte keys from one passphrase', async () => {
    // Same passphrase, same address, same parameters, and still nothing in
    // common: the salts differ. This is what the split rests on — the auth key
    // travels to the server, and it must say nothing about the one that stays.
    const authKey = await deriveAuthKey(PASSPHRASE, EMAIL, FAST_KDF);
    const encryptionKey = await deriveEncryptionKey(PASSPHRASE, EMAIL, FAST_KDF);

    expect(authKey).toHaveLength(32);
    expect(encryptionKey).toHaveLength(32);
    expect(equalBytes(authKey, encryptionKey)).toBe(false);
  });

  it('is deterministic, so the same passphrase reaches the same account', async () => {
    const [first, second] = await Promise.all([
      deriveAuthKey(PASSPHRASE, EMAIL, FAST_KDF),
      deriveAuthKey(PASSPHRASE, EMAIL, FAST_KDF),
    ]);
    expect(equalBytes(first, second)).toBe(true);
  });

  it('changes the auth key with the passphrase, which is what /v1/login checks', async () => {
    const a = await deriveAuthKey(PASSPHRASE, EMAIL, FAST_KDF);
    const b = await deriveAuthKey(`${PASSPHRASE}!`, EMAIL, FAST_KDF);
    expect(equalBytes(a, b)).toBe(false);
  });

  it('changes the auth key with the address', async () => {
    const a = await deriveAuthKey(PASSPHRASE, EMAIL, FAST_KDF);
    const b = await deriveAuthKey(PASSPHRASE, 'other@example.com', FAST_KDF);
    expect(equalBytes(a, b)).toBe(false);
  });
});

describe('data key wrapping', () => {
  const dataKey = new Uint8Array(32).fill(11);
  const wrappingKey = new Uint8Array(32).fill(22);
  const otherKey = new Uint8Array(32).fill(33);

  it('round-trips the data key', () => {
    expect(Array.from(unwrapDataKey(wrapDataKey(dataKey, wrappingKey), wrappingKey))).toEqual(
      Array.from(dataKey),
    );
  });

  it('refuses the wrong wrapping key rather than returning garbage', () => {
    expect(() => unwrapDataKey(wrapDataKey(dataKey, wrappingKey), otherKey)).toThrow();
  });

  it('detects a tampered wrapped key', () => {
    const wrapped = wrapDataKey(dataKey, wrappingKey);
    wrapped[wrapped.length - 1] ^= 0x01;
    expect(() => unwrapDataKey(wrapped, wrappingKey)).toThrow();
  });

  it('produces a fresh nonce each time, so two wrappings of one key differ', () => {
    const a = wrapDataKey(dataKey, wrappingKey);
    const b = wrapDataKey(dataKey, wrappingKey);
    expect(equalBytes(a, b)).toBe(false);
  });

  it('fits well inside the 512-byte field the server allows', () => {
    expect(wrapDataKey(dataKey, wrappingKey).length).toBeLessThanOrEqual(512);
  });

  it('rejects a data key that is not 32 bytes', () => {
    expect(() => wrapDataKey(new Uint8Array(16), wrappingKey)).toThrow(/32 bytes/);
  });
});

describe('data keys', () => {
  it('mints 32 random bytes', () => {
    const a = generateDataKey();
    expect(a).toHaveLength(32);
    expect(equalBytes(a, generateDataKey())).toBe(false);
  });
});

describe('recovery keys', () => {
  it('is 32 characters of Crockford base32, in groups of four', () => {
    const key = generateRecoveryKey();
    expect(key).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/);
    expect(normaliseRecoveryKey(key)).toHaveLength(Math.ceil((RECOVERY_KEY_BYTES * 8) / 5));
  });

  it('never repeats', () => {
    expect(generateRecoveryKey()).not.toBe(generateRecoveryKey());
  });

  it('groups a bare key for writing down', () => {
    expect(formatRecoveryKey('ABCDEFGH')).toBe('ABCD-EFGH');
  });

  it('forgives the ways a hand-copied key goes wrong', () => {
    // Crockford leaves I, L and O out precisely so they can fold onto 1 and 0.
    expect(normaliseRecoveryKey('il o1 0')).toBe('11010');
    expect(normaliseRecoveryKey('abcd-efgh')).toBe('ABCDEFGH');
    expect(normaliseRecoveryKey('  ab cd  ')).toBe('ABCD');
  });

  it('derives the same wrapping key however the user typed it back', () => {
    const key = generateRecoveryKey();
    const retyped = key.toLowerCase().replace(/-/g, ' ');
    expect(equalBytes(recoveryWrappingKey(key), recoveryWrappingKey(retyped))).toBe(true);
  });

  it('derives a 32-byte wrapping key that can open its own wrapping', () => {
    const recovery = generateRecoveryKey();
    const dataKey = generateDataKey();
    const wrapped = wrapDataKey(dataKey, recoveryWrappingKey(recovery));
    expect(Array.from(unwrapDataKey(wrapped, recoveryWrappingKey(recovery)))).toEqual(
      Array.from(dataKey),
    );
  });

  it('gives different wrapping keys for different recovery keys', () => {
    expect(
      equalBytes(recoveryWrappingKey(generateRecoveryKey()), recoveryWrappingKey(generateRecoveryKey())),
    ).toBe(false);
  });

  it('rejects a key of the wrong length', () => {
    expect(() => recoveryWrappingKey('ABCD-EFGH')).toThrow(/32 characters/);
  });
});
