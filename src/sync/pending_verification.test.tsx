/**
 * What happens to an outstanding code when the app stops running.
 *
 * The app is killed constantly on a phone — the user swaps to their mail client
 * to read the six digits, and Android takes the memory back while they are
 * there. Before this the challenge lived only in memory, so coming back landed
 * them at the gate with a live code in their inbox that answered nothing and a
 * registration on the server they could not finish. These check that the code
 * screen is what they come back to, and that the record behind it goes the
 * moment the challenge does.
 *
 * Stateless, like the delete tests beside them: no keystore, no server, and no
 * key stretching. The keystore is a Map, which is what makes "a restart" here
 * simply mounting the provider a second time over the same one.
 */
import { act, create } from 'react-test-renderer';

import { AccountProvider, useAccount } from './account';
import * as api from './api';
import { deriveEncryptionKey } from './keys';

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
  register: jest.fn(),
  prelogin: jest.fn(),
  login: jest.fn(),
}));

// Everything that is either seconds of key stretching or a call into the
// platform's randomness. What is derived is not under test here — that a
// restored registration starts deriving again is.
jest.mock('./keys', () => ({
  ...jest.requireActual('./keys'),
  deriveAuthKey: jest.fn(async () => new Uint8Array(32).fill(1)),
  deriveEncryptionKey: jest.fn(async () => new Uint8Array(32).fill(2)),
  generateDataKey: jest.fn(() => new Uint8Array(32).fill(3)),
  generateRecoveryKey: jest.fn(() => 'RECOVERY-KEY'),
  recoveryWrappingKey: jest.fn(() => new Uint8Array(32).fill(4)),
  wrapDataKey: jest.fn(() => new Uint8Array(48).fill(5)),
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

const keystore = jest.requireMock('expo-secure-store') as { __store: Map<string, string> };

const ACCOUNT_KEY = 'sync_account';
const SESSION_KEY = 'sync_session';
const PENDING_KEY = 'sync_pending';

const EMAIL = 'ada@example.com';
const PASSPHRASE = 'correct horse battery staple';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The server's answer to `/v1/register` or `/v1/login`. */
function challenge(purpose: 'register' | 'login', ageSeconds = 0) {
  return {
    challenge_id: `challenge-${purpose}`,
    email: EMAIL,
    purpose,
    code_expires_at: nowSeconds() + 15 * 60 - ageSeconds,
    expires_at: nowSeconds() + 30 * 60 - ageSeconds,
  };
}

type Account = ReturnType<typeof useAccount>;

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
  (api.register as jest.Mock).mockResolvedValue(challenge('register'));
  (api.login as jest.Mock).mockResolvedValue(challenge('login'));
  (api.prelogin as jest.Mock).mockResolvedValue({
    kdf: { algorithm: 'scrypt', memory_kib: 65536, block_size: 8, parallelism: 1 },
    authKdf: { algorithm: 'argon2id', memory_kib: 8192, iterations: 1, parallelism: 1 },
  });
});

describe('a challenge that is still outstanding', () => {
  it('is written where a restart can find it when a registration starts', async () => {
    const account = await mountAccount();

    await act(async () => {
      await account.current().register(EMAIL, PASSPHRASE);
    });

    expect(account.current().pendingVerification?.purpose).toBe('register');
    const stored = JSON.parse(keystore.__store.get(PENDING_KEY) as string);
    expect(stored.purpose).toBe('register');
    expect(stored.challenge.challengeId).toBe('challenge-register');
    // The one secret in the record, and the only thing that lets the flow be
    // picked up where it was left.
    expect(stored.passphrase).toBe(PASSPHRASE);
  });

  it('keeps a sign-in’s auth key, so coming back does not stretch the passphrase again', async () => {
    const account = await mountAccount();

    await act(async () => {
      await account.current().signIn(EMAIL, PASSPHRASE);
    });

    const stored = JSON.parse(keystore.__store.get(PENDING_KEY) as string);
    expect(stored.purpose).toBe('login');
    expect(stored.authKey).toBe(Buffer.from(new Uint8Array(32).fill(1)).toString('base64'));
    expect(stored.authKdf).toEqual({
      algorithm: 'argon2id',
      memory_kib: 8192,
      iterations: 1,
      parallelism: 1,
    });
  });
});

describe('coming back after the app was killed', () => {
  it('lands on the code screen with the same challenge, not at the gate', async () => {
    const first = await mountAccount();
    await act(async () => {
      await first.current().register(EMAIL, PASSPHRASE);
    });

    jest.clearAllMocks();
    const second = await mountAccount();

    expect(second.current().state).toBe('signed_out');
    expect(second.current().pendingVerification).toEqual({
      challengeId: 'challenge-register',
      email: EMAIL,
      purpose: 'register',
      codeExpiresAt: expect.any(Number),
      expiresAt: expect.any(Number),
    });
    // Nothing was asked for again: the code already in the inbox still answers.
    expect(api.register).not.toHaveBeenCalled();
    // The material that did not survive is simply derived again, in the
    // background, exactly as it was when the code first went out.
    expect(deriveEncryptionKey).toHaveBeenCalled();
  });

  it('comes back to a sign-in the same way', async () => {
    const first = await mountAccount();
    await act(async () => {
      await first.current().signIn(EMAIL, PASSPHRASE);
    });

    jest.clearAllMocks();
    const second = await mountAccount();

    expect(second.current().pendingVerification?.purpose).toBe('login');
    expect(api.login).not.toHaveBeenCalled();
    // A sign-in's slow key work belongs after the code, not before it.
    expect(deriveEncryptionKey).not.toHaveBeenCalled();
  });

  it('goes to the gate once the challenge has outlived its deadline', async () => {
    const dead = challenge('register');
    keystore.__store.set(
      PENDING_KEY,
      JSON.stringify({
        purpose: 'register',
        challenge: {
          challengeId: dead.challenge_id,
          email: EMAIL,
          purpose: 'register',
          codeExpiresAt: nowSeconds() - 60 * 60,
          expiresAt: nowSeconds() - 30 * 60,
        },
        passphrase: PASSPHRASE,
      }),
    );

    const account = await mountAccount();

    expect(account.current().state).toBe('signed_out');
    expect(account.current().pendingVerification).toBeNull();
  });

  it('drops a challenge left over from before this device was enrolled', async () => {
    const account = await mountAccount();
    await act(async () => {
      await account.current().register(EMAIL, PASSPHRASE);
    });

    keystore.__store.set(ACCOUNT_KEY, JSON.stringify({ user_id: 'user-1', email: EMAIL }));
    keystore.__store.set(
      SESSION_KEY,
      JSON.stringify({
        token: 'session-token',
        expires_at: nowSeconds() + 7 * 24 * 60 * 60,
        refreshed_at: nowSeconds(),
      }),
    );

    const signedIn = await mountAccount();

    expect(signedIn.current().state).toBe('signed_in');
    expect(signedIn.current().pendingVerification).toBeNull();
    expect(keystore.__store.has(PENDING_KEY)).toBe(false);
  });
});

describe('backing out of the code screen', () => {
  it('takes the record, and the passphrase in it, off the device', async () => {
    const account = await mountAccount();
    await act(async () => {
      await account.current().register(EMAIL, PASSPHRASE);
    });
    expect(keystore.__store.has(PENDING_KEY)).toBe(true);

    await act(async () => {
      account.current().cancelVerification();
    });

    expect(account.current().pendingVerification).toBeNull();
    expect(keystore.__store.has(PENDING_KEY)).toBe(false);

    // And a restart after that is a restart at the gate.
    const second = await mountAccount();
    expect(second.current().pendingVerification).toBeNull();
  });
});
