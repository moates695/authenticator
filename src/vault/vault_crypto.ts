import { bytesToHex, bytesToUtf8, hexToBytes, utf8ToBytes } from '@noble/ciphers/utils.js';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Directory, File, Paths } from 'expo-file-system';

import { KEY_BYTES, seal, unseal } from './envelope';
import { emptyVault, type Vault } from './types';

/**
 * The vault at rest. The framing lives in `envelope`, which the server-side copy
 * and the wrapped data keys share, so the blob the server holds is byte-
 * identical to the one on disk and equally opaque to it.
 *
 * The 32-byte data key lives in the platform keystore (Keychain on iOS, Android
 * Keystore via expo-secure-store) and never touches this file. Since sync
 * landed, that key is minted once and then wrapped under the account passphrase
 * and the recovery key, so a lost phone is recoverable — but the key itself is
 * still stored device-only and is never uploaded unwrapped.
 */
const DATA_KEY_ID = 'vault_data_key';
const VAULT_FILENAME = 'vault.bin';

const KEYSTORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

function vaultFile(): File {
  return new File(Paths.document, VAULT_FILENAME);
}

/**
 * Returns the data key already held on this device, or null if there is none.
 *
 * Separate from `loadDataKey` because enrolling for sync has to know whether it
 * is wrapping an existing key — and so preserving the codes already here — or
 * minting the first one.
 */
export async function peekDataKey(): Promise<Uint8Array | null> {
  const stored = await SecureStore.getItemAsync(DATA_KEY_ID);
  if (!stored) return null;

  try {
    const key = hexToBytes(stored);
    // A wrong-length key means a corrupted entry. Any vault ciphertext written
    // under it is unrecoverable at that point anyway.
    return key.length === KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}

/**
 * Installs a data key that came from somewhere else — unwrapped from the sync
 * account on a new device, or after a passphrase change.
 *
 * This replaces whatever was here, so anything still encrypted under the old
 * key becomes unreadable. Callers restore the matching vault immediately after.
 */
export async function installDataKey(key: Uint8Array): Promise<void> {
  if (key.length !== KEY_BYTES) {
    throw new Error(`Data key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
  await SecureStore.setItemAsync(DATA_KEY_ID, bytesToHex(key), KEYSTORE_OPTIONS);
}

/**
 * Returns the vault's data key, generating and persisting one on first run.
 * Callers hold the result only for the duration of an encrypt or decrypt.
 */
async function loadDataKey(): Promise<Uint8Array> {
  const existing = await peekDataKey();
  if (existing) return existing;

  const key = Crypto.getRandomBytes(KEY_BYTES);
  await SecureStore.setItemAsync(DATA_KEY_ID, bytesToHex(key), KEYSTORE_OPTIONS);
  return key;
}

export function encryptVault(vault: Vault, key: Uint8Array): Uint8Array {
  return seal(utf8ToBytes(JSON.stringify(vault)), key);
}

export function decryptVault(blob: Uint8Array, key: Uint8Array): Vault {
  return JSON.parse(bytesToUtf8(unseal(blob, key))) as Vault;
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
  temp.move(destination);
}

/** The vault exactly as it should be sent to the server: same bytes as on disk. */
export async function readVaultBlob(): Promise<Uint8Array> {
  const file = vaultFile();
  if (file.exists) return file.bytesSync();

  // Nothing written yet. Seal the empty vault rather than pushing nothing, so
  // the account always holds a real backup from the moment it is created.
  return encryptVault(emptyVault(), await loadDataKey());
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
