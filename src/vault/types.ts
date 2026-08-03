export type OtpType = 'totp' | 'hotp';
export type OtpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

/** Folders are deliberately single-depth: a folder holds entries, never other folders. */
export type Folder = {
  id: string;
  name: string;
  order: number;
  updated_at: number;
};

export type Entry = {
  id: string;
  /** null means the entry sits at the top level, outside any folder. */
  folder_id: string | null;
  issuer: string;
  account: string;
  /** Base32, unpadded. The sensitive part — only ever held decrypted in memory. */
  secret: string;
  type: OtpType;
  algorithm: OtpAlgorithm;
  digits: number;
  /** Seconds per code. Only meaningful for TOTP. */
  period: number;
  /** Only meaningful for HOTP; incremented each time a code is revealed. */
  counter: number;
  order: number;
  created_at: number;
  updated_at: number;
};

/**
 * Deletes leave a tombstone rather than vanishing, so a later sync can tell
 * "deleted on the other device" apart from "not yet seen on this device".
 */
export type Tombstone = {
  id: string;
  kind: 'entry' | 'folder';
  deleted_at: number;
};

export type Vault = {
  schema_version: 1;
  folders: Folder[];
  entries: Entry[];
  tombstones: Tombstone[];
  updated_at: number;
};

export function emptyVault(): Vault {
  return {
    schema_version: 1,
    folders: [],
    entries: [],
    tombstones: [],
    updated_at: Date.now(),
  };
}

export const DEFAULT_PERIOD = 30;
export const DEFAULT_DIGITS = 6;
export const DEFAULT_ALGORITHM: OtpAlgorithm = 'SHA1';

/** A label for the row, falling back sensibly when issuer or account is blank. */
export function entryTitle(entry: Entry): string {
  return entry.issuer.trim() || entry.account.trim() || 'Unnamed';
}

export function entrySubtitle(entry: Entry): string {
  const account = entry.account.trim();
  // When there is no issuer the account has already been promoted to the title.
  return entry.issuer.trim() ? account : '';
}
