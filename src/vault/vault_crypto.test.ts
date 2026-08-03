import { decryptVault, encryptVault } from './vault_crypto';
import { emptyVault, type Entry, type Vault } from './types';

const KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(9);

function sampleVault(): Vault {
  const entry: Entry = {
    id: 'entry-1',
    folder_id: 'folder-1',
    issuer: 'GitHub',
    account: 'me@example.com',
    secret: 'JBSWY3DPEHPK3PXP',
    type: 'totp',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    counter: 0,
    order: 0,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
  };

  return {
    ...emptyVault(),
    folders: [{ id: 'folder-1', name: 'Work', order: 0, updated_at: 1_700_000_000_000 }],
    entries: [entry],
  };
}

describe('vault encryption', () => {
  it('round-trips a vault unchanged', () => {
    const vault = sampleVault();
    expect(decryptVault(encryptVault(vault, KEY), KEY)).toEqual(vault);
  });

  it('round-trips an empty vault', () => {
    const vault = emptyVault();
    expect(decryptVault(encryptVault(vault, KEY), KEY)).toEqual(vault);
  });

  it('produces different ciphertext each time, so writes do not leak that nothing changed', () => {
    const vault = sampleVault();
    const a = encryptVault(vault, KEY);
    const b = encryptVault(vault, KEY);
    expect(Array.from(a)).not.toEqual(Array.from(b));
    // Both still decrypt to the same vault.
    expect(decryptVault(a, KEY)).toEqual(decryptVault(b, KEY));
  });

  it('never leaves the secret readable in the encrypted blob', () => {
    const blob = encryptVault(sampleVault(), KEY);
    const asText = Buffer.from(blob).toString('utf8');
    expect(asText).not.toContain('JBSWY3DPEHPK3PXP');
    expect(asText).not.toContain('GitHub');
  });

  it('writes the format version as the first byte', () => {
    expect(encryptVault(sampleVault(), KEY)[0]).toBe(1);
  });
});

describe('vault decryption failures', () => {
  it('refuses the wrong key rather than returning garbage', () => {
    const blob = encryptVault(sampleVault(), KEY);
    expect(() => decryptVault(blob, OTHER_KEY)).toThrow();
  });

  it('detects a flipped bit in the ciphertext', () => {
    const blob = encryptVault(sampleVault(), KEY);
    blob[blob.length - 1] ^= 0x01;
    expect(() => decryptVault(blob, KEY)).toThrow();
  });

  it('detects a tampered nonce', () => {
    const blob = encryptVault(sampleVault(), KEY);
    // Byte 1 is the first byte of the 24-byte nonce.
    blob[1] ^= 0xff;
    expect(() => decryptVault(blob, KEY)).toThrow();
  });

  it('rejects an unknown format version', () => {
    const blob = encryptVault(sampleVault(), KEY);
    blob[0] = 99;
    expect(() => decryptVault(blob, KEY)).toThrow(/unsupported vault format version 99/i);
  });

  it('rejects a truncated blob', () => {
    expect(() => decryptVault(new Uint8Array(10), KEY)).toThrow(/truncated/i);
  });
});
