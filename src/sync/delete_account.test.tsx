/**
 * The delete path through the account provider.
 *
 * Everything the provider touches on the way is mocked, so these are stateless:
 * no keystore, no vault file, no server, and no Argon2id. What is being checked
 * is the order things happen in, which for an irreversible action is the whole
 * design — the device is wiped only once the server has confirmed, and a
 * refused delete has to leave the account exactly as it found it.
 */
import { act, create } from 'react-test-renderer';

import { destroyVault } from '@/vault/vault_crypto';
import { AccountProvider, useAccount } from './account';
import * as api from './api';
import { SyncError } from './api';
import { deriveAuthKey } from './keys';

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => void store.set(key, value)),
    deleteItemAsync: jest.fn(async (key: string) => void store.delete(key)),
  };
});

// `api.ts` resolves its base URL at import time and a development build with no
// server configured refuses to guess one. Nothing here sends a request.
jest.mock('./sync_url', () => ({
  ...jest.requireActual('./sync_url'),
  syncBaseUrl: () => 'http://localhost:8000',
}));

jest.mock('./api', () => ({
  ...jest.requireActual('./api'),
  prelogin: jest.fn(),
  deleteAccount: jest.fn(),
  logout: jest.fn(),
}));

// The real one is seconds of Argon2id, and what it derives is not what is
// under test — that it is derived from the account's own parameters is.
jest.mock('./keys', () => ({
  ...jest.requireActual('./keys'),
  deriveAuthKey: jest.fn(async () => new Uint8Array(32).fill(3)),
}));

jest.mock('@/vault/vault_crypto', () => ({
  destroyVault: jest.fn(async () => {}),
  vaultExists: jest.fn(() => false),
  readVault: jest.fn(),
  readVaultBlob: jest.fn(),
  writeVault: jest.fn(),
  installDataKey: jest.fn(),
  peekDataKey: jest.fn(async () => null),
  decryptVault: jest.fn(),
}));

const keystore = jest.requireMock('expo-secure-store') as {
  __store: Map<string, string>;
  deleteItemAsync: jest.Mock;
};

const ACCOUNT_KEY = 'sync_account';
const SESSION_KEY = 'sync_session';

const EMAIL = 'ada@example.com';
const TOKEN = 'session-token';
const PASSPHRASE = 'correct horse battery staple';

/** Older than the current defaults, which is the point: a delete must use it. */
const ACCOUNT_AUTH_KDF = {
  algorithm: 'argon2id' as const,
  memory_kib: 4096,
  iterations: 2,
  parallelism: 1,
};

type Account = ReturnType<typeof useAccount>;

/** Puts a live enrolment in the keystore, so the provider restores signed in. */
function seedSignedIn(): void {
  keystore.__store.set(ACCOUNT_KEY, JSON.stringify({ user_id: 'user-1', email: EMAIL }));
  keystore.__store.set(
    SESSION_KEY,
    JSON.stringify({
      token: TOKEN,
      expires_at: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
      refreshed_at: Math.floor(Date.now() / 1000),
    }),
  );
}

/** Renders the provider and hands back a live view of its context value. */
async function mountAccount(): Promise<{ current: () => Account }> {
  let latest: Account | null = null;

  function Probe() {
    latest = useAccount();
    return null;
  }

  await act(async () => {
    create(
      <AccountProvider>
        <Probe />
      </AccountProvider>,
    );
  });

  return { current: () => latest as Account };
}

beforeEach(() => {
  jest.clearAllMocks();
  keystore.__store.clear();
  (api.prelogin as jest.Mock).mockResolvedValue({
    kdf: ACCOUNT_AUTH_KDF,
    authKdf: ACCOUNT_AUTH_KDF,
  });
  (api.deleteAccount as jest.Mock).mockResolvedValue(undefined);
});

describe('deleting the account', () => {
  it('authorises with the passphrase, under the account’s own parameters', async () => {
    seedSignedIn();
    const account = await mountAccount();
    expect(account.current().state).toBe('signed_in');

    await act(async () => {
      await account.current().deleteAccount(PASSPHRASE);
    });

    expect(api.prelogin).toHaveBeenCalledWith(EMAIL);
    expect(deriveAuthKey).toHaveBeenCalledWith(PASSPHRASE, EMAIL, ACCOUNT_AUTH_KDF);
    expect(api.deleteAccount).toHaveBeenCalledWith(TOKEN, new Uint8Array(32).fill(3));
  });

  it('wipes the device once the server has confirmed, and lands signed out', async () => {
    seedSignedIn();
    const account = await mountAccount();

    let deleted: boolean | undefined;
    await act(async () => {
      deleted = await account.current().deleteAccount(PASSPHRASE);
    });

    expect(deleted).toBe(true);
    expect(destroyVault).toHaveBeenCalled();
    expect(keystore.__store.has(ACCOUNT_KEY)).toBe(false);
    expect(keystore.__store.has(SESSION_KEY)).toBe(false);

    expect(account.current().state).toBe('signed_out');
    expect(account.current().account).toBeNull();
    // Nothing is held for the next screen: there is no account to go back to.
    expect(account.current().lastEmail).toBeNull();
    expect(account.current().sessionExpired).toBe(false);
  });

  it('leaves everything alone when the passphrase is refused', async () => {
    seedSignedIn();
    (api.deleteAccount as jest.Mock).mockRejectedValue(
      new SyncError(401, 'Passphrase is incorrect.'),
    );
    const account = await mountAccount();

    let deleted: boolean | undefined;
    await act(async () => {
      deleted = await account.current().deleteAccount('not the passphrase');
    });

    expect(deleted).toBe(false);
    expect(destroyVault).not.toHaveBeenCalled();
    expect(keystore.__store.has(ACCOUNT_KEY)).toBe(true);
    expect(keystore.__store.has(SESSION_KEY)).toBe(true);

    expect(account.current().state).toBe('signed_in');
    expect(account.current().account?.email).toBe(EMAIL);
    expect(account.current().error).toBe('Passphrase is incorrect.');
  });

  it('leaves everything alone when the server cannot be reached', async () => {
    seedSignedIn();
    (api.prelogin as jest.Mock).mockRejectedValue(new SyncError(0, 'Could not reach the server.'));
    const account = await mountAccount();

    let deleted: boolean | undefined;
    await act(async () => {
      deleted = await account.current().deleteAccount(PASSPHRASE);
    });

    expect(deleted).toBe(false);
    expect(api.deleteAccount).not.toHaveBeenCalled();
    expect(destroyVault).not.toHaveBeenCalled();
    expect(account.current().state).toBe('signed_in');
  });

  it('does not reach the server with nobody signed in', async () => {
    const account = await mountAccount();
    expect(account.current().state).toBe('signed_out');

    let deleted: boolean | undefined;
    await act(async () => {
      deleted = await account.current().deleteAccount(PASSPHRASE);
    });

    expect(deleted).toBe(false);
    expect(api.prelogin).not.toHaveBeenCalled();
    expect(api.deleteAccount).not.toHaveBeenCalled();
    expect(destroyVault).not.toHaveBeenCalled();
  });
});
