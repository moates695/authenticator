import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import * as Crypto from 'expo-crypto';

/**
 * The one encrypted container format this app uses:
 *
 *   byte 0        format version
 *   bytes 1..24   XChaCha20 nonce (24 bytes, fresh on every seal)
 *   bytes 25..    XChaCha20-Poly1305 ciphertext with appended 16-byte tag
 *
 * The vault on disk, the vault the server holds, and the wrapped copies of the
 * data key are all this same shape. Keeping one implementation means there is a
 * single place where the nonce is generated and the version is checked, rather
 * than three that have to be kept in step.
 *
 * A 24-byte nonce is wide enough that generating it randomly on every write is
 * safe without tracking a counter, which matters because the same data key is
 * used from more than one device.
 */
export const ENVELOPE_VERSION = 1;
export const NONCE_BYTES = 24;
export const KEY_BYTES = 32;
const TAG_BYTES = 16;

/** Encrypts `plaintext` under `key`, returning the framed blob. */
export function seal(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = Crypto.getRandomBytes(NONCE_BYTES);
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(plaintext);

  const out = new Uint8Array(1 + NONCE_BYTES + ciphertext.length);
  out[0] = ENVELOPE_VERSION;
  out.set(nonce, 1);
  out.set(ciphertext, 1 + NONCE_BYTES);
  return out;
}

/**
 * Decrypts a blob produced by `seal`. Throws on a truncated blob, an unknown
 * version, or a failed authentication tag — never returns partial plaintext.
 */
export function unseal(blob: Uint8Array, key: Uint8Array): Uint8Array {
  if (blob.length < 1 + NONCE_BYTES + TAG_BYTES) {
    throw new Error('Encrypted data is truncated');
  }
  if (blob[0] !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported encrypted format version ${blob[0]}`);
  }

  const nonce = blob.subarray(1, 1 + NONCE_BYTES);
  const ciphertext = blob.subarray(1 + NONCE_BYTES);
  return xchacha20poly1305(key, nonce).decrypt(ciphertext);
}
