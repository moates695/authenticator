import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToHex, bytesToUtf8, hexToBytes, utf8ToBytes } from '@noble/ciphers/utils.js';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Directory, File, Paths } from 'expo-file-system';

import { emptyVault, type Vault } from './types';

/**
 * Local-at-rest format for the vault:
 *
 *   byte 0        format version
 *   bytes 1..24   XChaCha20 nonce (24 bytes, fresh on every write)
 *   bytes 25..    XChaCha20-Poly1305 ciphertext with appended 16-byte tag
 *
 * The 32-byte data key lives in the platform keystore (Keychain on iOS,
 * Android Keystore via expo-secure-store) and never touches this file.
 * Remote sync will reuse this same envelope, so the blob the server holds is
 * byte-identical to the one on disk and equally opaque to it.
 */
const FORMAT_VERSION = 1;
const NONCE_BYTES = 24;
const KEY_BYTES = 32;
const DATA_KEY_ID = 'vault_data_key';
const VAULT_FILENAME = 'vault.bin';

function vaultFile(): File {
  return new File(Paths.document, VAULT_FILENAME);
}

/**
 * Returns the vault's data key, generating and persisting one on first run.
 * Callers hold the result only for the duration of an encrypt or decrypt.
 */
async function loadDataKey(): Promise<Uint8Array> {
  const stored = await SecureStore.getItemAsync(DATA_KEY_ID);
  if (stored) {
    const key = hexToBytes(stored);
    if (key.length === KEY_BYTES) return key;
    // A wrong-length key means a corrupted entry; fall through and mint a new
    // one. Any existing vault ciphertext is unrecoverable at that point anyway.
  }

  const key = Crypto.getRandomBytes(KEY_BYTES);
  await SecureStore.setItemAsync(DATA_KEY_ID, bytesToHex(key), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return key;
}

export function encryptVault(vault: Vault, key: Uint8Array): Uint8Array {
  const nonce = Crypto.getRandomBytes(NONCE_BYTES);
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(utf8ToBytes(JSON.stringify(vault)));

  const out = new Uint8Array(1 + NONCE_BYTES + ciphertext.length);
  out[0] = FORMAT_VERSION;
  out.set(nonce, 1);
  out.set(ciphertext, 1 + NONCE_BYTES);
  return out;
}

export function decryptVault(blob: Uint8Array, key: Uint8Array): Vault {
  if (blob.length < 1 + NONCE_BYTES + 16) {
    throw new Error('Vault file is truncated');
  }
  if (blob[0] !== FORMAT_VERSION) {
    throw new Error(`Unsupported vault format version ${blob[0]}`);
  }

  const nonce = blob.subarray(1, 1 + NONCE_BYTES);
  const ciphertext = blob.subarray(1 + NONCE_BYTES);
  const plaintext = xchacha20poly1305(key, nonce).decrypt(ciphertext);
  return JSON.parse(bytesToUtf8(plaintext)) as Vault;
}

/** Reads and decrypts the vault, returning a fresh empty one on first launch. */
export async function readVault(): Promise<Vault> {
  const file = vaultFile();
  if (!file.exists) return emptyVault();

  const key = await loadDataKey();
  return decryptVault(file.bytesSync(), key);
}

/**
 * Encrypts and writes the vault. The write goes to a sibling temp file first so
 * an interrupted save cannot leave a half-written vault behind.
 */
export async function writeVault(vault: Vault): Promise<void> {
  const key = await loadDataKey();
  const blob = encryptVault(vault, key);

  const documents = new Directory(Paths.document);
  if (!documents.exists) documents.create({ intermediates: true });

  const temp = new File(Paths.document, `${VAULT_FILENAME}.tmp`);
  if (temp.exists) temp.delete();
  temp.create();
  temp.write(blob);

  const destination = vaultFile();
  if (destination.exists) destination.delete();
  temp.moveSync(destination);
}

/** True once a vault file exists on disk, i.e. the app has been set up. */
export function vaultExists(): boolean {
  return vaultFile().exists;
}

/** Wipes local vault state. Used by "reset app" and by a future remote wipe. */
export async function destroyVault(): Promise<void> {
  const file = vaultFile();
  if (file.exists) file.delete();
  await SecureStore.deleteItemAsync(DATA_KEY_ID);
}
