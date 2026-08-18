import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { equalBytes } from '@noble/ciphers/utils.js';
import * as SecureStore from 'expo-secure-store';

import { emptyVault, type Vault } from '@/vault/types';
import {
  decryptVault,
  installDataKey,
  peekDataKey,
  readVault,
  readVaultBlob,
  vaultExists,
  writeVault,
} from '@/vault/vault_crypto';
import {
  VERIFICATION_CODE_LENGTH,
  devAutoLogin,
  isCompleteCode,
  isValidEmail,
  normaliseCode,
  normaliseEmail,
  parseStoredAccount,
  parseStoredSession,
  refreshDue,
  sessionIsLive,
  type AccountState,
  type PendingVerification,
  type StoredAccount,
  type StoredSession,
} from './account_policy';
import * as api from './api';
import { base64ToBytes, bytesToBase64 } from './base64';
import {
  AUTH_KDF,
  DEFAULT_KDF,
  deriveAuthKey,
  deriveEncryptionKey,
  generateDataKey,
  generateRecoveryKey,
  recoveryWrappingKey,
  sameKdf,
  unwrapDataKey,
  wrapDataKey,
  type KdfParams,
} from './keys';
import { peekable, type Peekable } from './peekable';

const ACCOUNT_KEY = 'sync_account';
const SESSION_KEY = 'sync_session';

const KEYSTORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/**
 * Signing in has one outcome the caller has to do something about rather than
 * just report: an account whose vault would overwrite codes already on this
 * device. That needs the user's word before it happens, so it comes back as a
 * result instead of being decided here.
 */
export type SignInOutcome =
  | { ok: true }
  | { ok: false; reason: 'error' }
  | { ok: false; reason: 'would_replace_local'; localCodes: number };

/**
 * Everything a registration needs ready by the time the code is typed: the
 * derived keys, the data key they protect, and the wrapped copies the server
 * stores. Produced in the background while the code screen is up — asking for
 * the code costs one round trip, so the slow derivation runs during the trip
 * to the inbox rather than before it.
 */
type RegistrationMaterial = {
  authKey: Uint8Array;
  encryptionKey: Uint8Array;
  dataKey: Uint8Array;
  recoveryKey: string;
  wrappedPassphrase: Uint8Array;
  wrappedRecovery: Uint8Array;
};

/**
 * What a challenge carries besides its id, kept in memory for as long as the
 * code is outstanding and never written anywhere.
 *
 * The two purposes hold different things because their derivations happen at
 * opposite ends of the code. A registration has already started its keys — the
 * server needed nothing but an address to send the code — so this is a promise
 * that `submitCode` waits out. A sign-in has proved its passphrase with the
 * light auth key and holds the passphrase itself, because the encryption key is
 * not derived until the code comes back right.
 *
 * That none of it survives a restart is the point: a killed app leaves nothing
 * half-authenticated behind, and starting again costs a passphrase.
 */
type PendingKeys =
  | {
      purpose: 'login';
      email: string;
      passphrase: string;
      /**
       * Already derived, to satisfy `/v1/login`, and kept because a re-wrap
       * needs the same key again as proof of the passphrase — deriving it a
       * second time would be seconds of Argon2id for a value we are holding.
       */
      authKey: Uint8Array;
      /** The account's own auth parameters, which a re-wrap must not change. */
      authKdf: KdfParams;
    }
  | { purpose: 'register'; email: string; material: Peekable<RegistrationMaterial> };

type LoginKeys = Extract<PendingKeys, { purpose: 'login' }>;

/**
 * A registration derivation in flight or just finished, keyed by its inputs.
 * Argon2id cannot be aborted, only disowned — so if the user backs out of the
 * code screen and comes straight back, the pass already chewing through memory
 * is picked up again instead of a second one starting alongside it.
 */
type Derivation = {
  key: string;
  settled: boolean;
  promise: Promise<RegistrationMaterial>;
};

/**
 * A verified session waiting on one question: this device has codes the account
 * has never seen, and restoring the backup would take them with it.
 */
type PendingAdoption = {
  verified: api.LoginResponse;
  email: string;
  dataKey: Uint8Array;
  remoteVault: Vault | null;
  remoteVersion: number;
  localVault: Vault | null;
};

type AccountContextValue = {
  state: AccountState;
  account: StoredAccount | null;
  /**
   * The address this device was last enrolled as, kept after a session runs out
   * so signing back in is a passphrase rather than a passphrase and a memory.
   */
  lastEmail: string | null;
  /** True when the sign-in screen is up because the session ran out, not by choice. */
  sessionExpired: boolean;
  /** True while a derivation or request is running; the forms disable on it. */
  busy: boolean;
  /**
   * Where a submitted code has got to, so the screen can say. `checking` is the
   * round trip that decides whether the code is right and nothing more;
   * `finishing` is everything after it, which is where the slow key work lives.
   *
   * The difference matters on the code screen: until the code has been accepted
   * nothing should read as though it has been.
   */
  stage: 'checking' | 'finishing' | null;
  /** Argon2id progress, 0..1, or null when nothing is being derived. */
  progress: number | null;
  error: string | null;
  /** The challenge in flight, when a code has been sent and is being waited on. */
  pendingVerification: PendingVerification | null;
  /**
   * Set once, immediately after registering, and cleared when the user says
   * they have written it down. It is never recoverable after that.
   */
  pendingRecoveryKey: string | null;
  acknowledgeRecoveryKey: () => void;
  /** Both of these send a code and return whether it went; neither signs in. */
  register: (email: string, passphrase: string) => Promise<boolean>;
  signIn: (email: string, passphrase: string) => Promise<SignInOutcome>;
  /** Answers the challenge. The only call that produces a session. */
  submitCode: (code: string) => Promise<SignInOutcome>;
  resendCode: () => Promise<boolean>;
  cancelVerification: () => void;
  /** Goes ahead with a sign-in that overwrites the codes already on the device. */
  confirmReplaceLocal: () => Promise<boolean>;
  /**
   * Renews the session, and drops the device back to the sign-in screen if the
   * server says it is over. Called when the device unlock check is passed.
   */
  refreshSession: () => Promise<void>;
  signOut: () => Promise<void>;
  clearError: () => void;
};

const AccountContext = createContext<AccountContextValue | null>(null);

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The session as it is stored, stamped with when this device last renewed it. */
function toStoredSession(issued: { token: string; expires_at: number }): StoredSession {
  return { token: issued.token, expires_at: issued.expires_at, refreshed_at: nowSeconds() };
}

function toPending(challenge: api.ChallengeResponse): PendingVerification {
  return {
    challengeId: challenge.challenge_id,
    email: challenge.email,
    purpose: challenge.purpose,
    codeExpiresAt: challenge.code_expires_at,
    expiresAt: challenge.expires_at,
  };
}

/** Reads the local vault, treating an unreadable one as absent. */
async function readLocalVault(): Promise<Vault | null> {
  if (!vaultExists()) return null;
  try {
    return await readVault();
  } catch {
    // Written under a data key this device no longer has. There is nothing to
    // preserve, so it does not stand in the way of signing in.
    return null;
  }
}

function describe(err: unknown): string {
  if (err instanceof api.SyncError) return err.message;
  return (err as Error)?.message ?? 'Something went wrong.';
}

/**
 * Holds the sync account, and with it the vault's data key.
 *
 * The app does not open without one. That is a product decision as much as a
 * technical one: an authenticator whose only copy of your codes is on a phone
 * you might drop is a liability, so enrolling for backup is part of setup rather
 * than a setting to find later.
 *
 * Getting in takes two factors and always has. The passphrase is one; a code
 * emailed to the address on the account is the other, which is why `register`
 * and `signIn` end at a challenge and only `submitCode` produces a session. An
 * address that has never answered a code is an account that cannot be used.
 *
 * Both factors are for adopting a device, not for using one. After that the
 * session slides: every time the device's own unlock check is passed the token
 * is renewed for another full term, so the phone in someone's pocket is guarded
 * by their fingerprint, not by how recently they read an email. A device left
 * alone long enough for the term to run out is signed out and has to give both
 * factors again — the codes on it are still there, but the account is shut.
 */
export function AccountProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AccountState>('checking');
  const [account, setAccount] = useState<StoredAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<AccountContextValue['stage']>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingRecoveryKey, setPendingRecoveryKey] = useState<string | null>(null);
  const [pendingVerification, setPendingVerification] = useState<PendingVerification | null>(null);
  const [lastEmail, setLastEmail] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  /** The live session, held outside state because sync reads it between renders. */
  const session = useRef<StoredSession | null>(null);
  /** Guards against a second attempt stacking on a running derivation. */
  const inFlight = useRef(false);
  /** The challenge and its key material. State mirrors only the safe half. */
  const pending = useRef<{ challenge: PendingVerification; keys: PendingKeys } | null>(null);
  /** The registration derivation in flight, so a retry can reuse it. */
  const derivation = useRef<Derivation | null>(null);
  /** A verified sign-in paused on the "replace what is here?" question. */
  const adoption = useRef<PendingAdoption | null>(null);

  const saveSession = useCallback(async (next: StoredSession) => {
    session.current = next;
    await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(next), KEYSTORE_OPTIONS);
  }, []);

  const persist = useCallback(
    async (next: StoredAccount, token: StoredSession) => {
      await Promise.all([
        SecureStore.setItemAsync(ACCOUNT_KEY, JSON.stringify(next), KEYSTORE_OPTIONS),
        saveSession(token),
      ]);
      setLastEmail(next.email);
      setSessionExpired(false);
      setAccount(next);
      setState('signed_in');
    },
    [saveSession],
  );

  /**
   * Puts the gate back up because the session is over rather than because the
   * user asked to leave.
   *
   * The account record stays on the device: it is what fills the address in on
   * the way back, and the vault it belongs to is untouched. Only the token goes,
   * because only the token is what expired.
   */
  const requireSignIn = useCallback(async (email: string | null) => {
    session.current = null;
    await SecureStore.deleteItemAsync(SESSION_KEY).catch(() => {});
    setLastEmail(email);
    setSessionExpired(true);
    setAccount(null);
    setState('signed_out');
  }, []);

  const beginVerification = useCallback((challenge: api.ChallengeResponse, keys: PendingKeys) => {
    const next = toPending(challenge);
    pending.current = { challenge: next, keys };
    setPendingVerification(next);
  }, []);

  const endVerification = useCallback(() => {
    pending.current = null;
    adoption.current = null;
    // A finished derivation's keys go with the challenge they were made for; a
    // running one is kept, so retrying the same registration rejoins it rather
    // than starting a second Argon2id pass alongside it.
    if (derivation.current?.settled) derivation.current = null;
    setPendingVerification(null);
  }, []);

  const cancelVerification = useCallback(() => {
    endVerification();
    setError(null);
  }, [endVerification]);

  /**
   * Turns a passphrase into the key that unwraps the data key, reporting
   * progress along the way. This is the slow part — seconds, not milliseconds —
   * so everything that can fail cheaply is checked before it runs.
   *
   * `live` gates the progress reports: a derivation the user has walked away
   * from keeps running (it cannot be stopped), but it no longer owns the number
   * on screen.
   */
  const derive = useCallback(
    async (email: string, passphrase: string, kdf = DEFAULT_KDF, live: () => boolean = () => true) => {
      const report = (fraction: number | null) => {
        if (live()) setProgress(fraction);
      };
      report(0);
      try {
        return await deriveEncryptionKey(passphrase, email, kdf, report);
      } finally {
        report(null);
      }
    },
    [],
  );

  /**
   * Starts (or rejoins) the background derivation that readies everything a
   * registration sends with its code. Called the moment the code is on its way,
   * so the Argon2id pass runs while the user is off reading their inbox — by
   * the time the six digits are typed it is usually already done, and
   * `submitCode` waits out whatever is left.
   */
  const prepareRegistration = useCallback(
    (email: string, passphrase: string): Promise<RegistrationMaterial> => {
      const key = `${email} ${passphrase}`;
      if (derivation.current?.key === key) return derivation.current.promise;

      // The entry goes in the ref before the work starts: the derivation's
      // first progress report is synchronous, and only the current entry may
      // drive the number on screen.
      const entry: Derivation = { key, settled: false, promise: undefined as never };
      derivation.current = entry;
      entry.promise = (async () => {
        const encryptionKey = await derive(
          email,
          passphrase,
          DEFAULT_KDF,
          () => derivation.current === entry,
        );
        // A new account is made on the current parameters for both, so this one
        // needs no `/v1/prelogin` to know what to run. It is a fraction of the
        // pass above and nobody is waiting on it.
        const authKey = await deriveAuthKey(passphrase, email, AUTH_KDF);

        // An existing local vault keeps its key rather than being orphaned:
        // enrolling for backup must never cost the user the codes already here.
        const dataKey = (await peekDataKey()) ?? generateDataKey();
        const recoveryKey = generateRecoveryKey();

        return {
          authKey,
          encryptionKey,
          dataKey,
          recoveryKey,
          wrappedPassphrase: wrapDataKey(dataKey, encryptionKey),
          wrappedRecovery: wrapDataKey(dataKey, recoveryWrappingKey(recoveryKey)),
        };
      })();
      entry.promise
        .finally(() => {
          entry.settled = true;
          // Disowned while it ran — the user backed out of the code screen and
          // did not come back to it. Nothing may keep these keys.
          if (pending.current === null && derivation.current === entry) derivation.current = null;
        })
        .catch(() => {
          // Failures surface in submitCode, where the material is awaited.
        });
      return entry.promise;
    },
    [derive],
  );

  const register = useCallback(
    async (rawEmail: string, passphrase: string): Promise<boolean> => {
      if (inFlight.current) return false;

      const email = normaliseEmail(rawEmail);
      if (!isValidEmail(email)) {
        setError('That does not look like an email address.');
        return false;
      }

      inFlight.current = true;
      setBusy(true);
      setError(null);
      try {
        // The code first, the keys later. This request carries only the
        // address, so it returns in a round trip — an "already registered" is
        // known before any deriving starts — and the account is created when
        // the code and the material below meet at verify.
        const challenge = await api.register(email);

        // Nothing exists anywhere yet: no account on the server, nothing on
        // the device. The keys take shape here in memory while the code is in
        // transit, and wait with the challenge.
        beginVerification(challenge, {
          purpose: 'register',
          email,
          material: peekable(prepareRegistration(email, passphrase)),
        });
        return true;
      } catch (err) {
        setError(describe(err));
        return false;
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [beginVerification, prepareRegistration],
  );

  const signIn = useCallback(
    async (rawEmail: string, passphrase: string): Promise<SignInOutcome> => {
      if (inFlight.current) return { ok: false, reason: 'error' };

      const email = normaliseEmail(rawEmail);
      if (!isValidEmail(email)) {
        setError('That does not look like an email address.');
        return { ok: false, reason: 'error' };
      }

      inFlight.current = true;
      setBusy(true);
      setError(null);
      try {
        // The account's own parameters, which may be older than our defaults.
        const { authKdf } = await api.prelogin(email);

        // Only the light half runs here. It is what `/v1/login` checks, so a
        // wrong passphrase is turned away before any code is sent — and it is
        // over in a moment, where the encryption key would have been several
        // seconds of Argon2id in front of an empty screen.
        const authKey = await deriveAuthKey(passphrase, email, authKdf);

        // Proves the passphrase and nothing more; the server answers with a
        // challenge rather than a session, and sends the code.
        const challenge = await api.login(email, authKey);

        // The passphrase itself waits with the challenge, because what unwraps
        // the vault has not been derived yet and cannot be until the code comes
        // back. It lives in memory for as long as the code is outstanding, and
        // goes when the challenge does.
        beginVerification(challenge, { purpose: 'login', email, passphrase, authKey, authKdf });
        return { ok: true };
      } catch (err) {
        setError(describe(err));
        return { ok: false, reason: 'error' };
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [beginVerification],
  );

  /** Installs the account on this device, once there is a verified session. */
  const adopt = useCallback(
    async (ready: PendingAdoption): Promise<SignInOutcome> => {
      await installDataKey(ready.dataKey);
      await writeVault(ready.remoteVault ?? ready.localVault ?? emptyVault());

      // An account with no vault yet adopts whatever this device has, so the
      // codes are backed up from the first sign-in rather than the first edit.
      if (!ready.remoteVault) {
        try {
          await api.putVault(ready.verified.token, ready.remoteVersion, await readVaultBlob());
        } catch (err) {
          setError(`Signed in, but the first backup did not upload: ${describe(err)}`);
        }
      }

      await persist(
        { user_id: ready.verified.user_id, email: ready.email },
        toStoredSession(ready.verified),
      );
      endVerification();
      return { ok: true };
    },
    [endVerification, persist],
  );

  const completeRegistration = useCallback(
    async (
      verified: api.LoginResponse,
      email: string,
      material: RegistrationMaterial,
    ): Promise<SignInOutcome> => {
      await installDataKey(material.dataKey);
      await persist({ user_id: verified.user_id, email }, toStoredSession(verified));
      endVerification();
      setPendingRecoveryKey(material.recoveryKey);

      // The account is real either way; a first upload that fails is caught up
      // by the next sync rather than being worth unwinding a registration for.
      try {
        await api.putVault(verified.token, verified.vault_version, await readVaultBlob());
      } catch (err) {
        setError(`Account created, but the first backup did not upload: ${describe(err)}`);
      }

      return { ok: true };
    },
    [endVerification, persist],
  );

  /**
   * Moves an account onto today's derivation parameters, and is how a change to
   * `DEFAULT_KDF` ever reaches an account that already exists.
   *
   * It cannot be done on the server. What the parameters protect is
   * `wrapped_passphrase`, and re-wrapping means deriving a key from the
   * passphrase — which the server has never held and never will. So the only
   * moment it can happen is one where a device has the passphrase in hand and
   * has just proved it: this one.
   *
   * Only the passphrase wrapping is rebuilt. The recovery wrapping goes back up
   * exactly as it came down, because the key that opens it is 160 bits of
   * machine randomness put through no KDF at all — there are no parameters on
   * that side to be out of date, and the recovery key itself is on a piece of
   * paper somewhere rather than on this device. The auth key and its parameters
   * are likewise passed straight through: this is not a passphrase change, and
   * declaring auth parameters the stored key was not made under would lock the
   * account out of `/v1/login` for good.
   *
   * Returns the session to carry on with. `/v1/keys` ends every session it
   * finds, this one included, and issues a fresh token — so the response is the
   * only way back in, and it has to replace what the caller was holding. On any
   * failure the original comes back untouched and the account stays on its old
   * parameters, to be tried again at the next sign-in.
   */
  const upgradeStoredKdf = useCallback(
    async (
      verified: api.LoginResponse,
      keys: LoginKeys,
      dataKey: Uint8Array,
    ): Promise<api.LoginResponse> => {
      if (sameKdf(verified.kdf, DEFAULT_KDF)) return verified;

      try {
        // The user is through both factors and waiting on the vault either way,
        // so this reports progress rather than running behind their back. It is
        // one derivation, once, for the life of the account.
        const encryptionKey = await derive(keys.email, keys.passphrase, DEFAULT_KDF);
        const wrappedPassphrase = wrapDataKey(dataKey, encryptionKey);
        const session = await api.putKeys(verified.token, {
          currentAuthKey: keys.authKey,
          newAuthKey: keys.authKey,
          kdf: DEFAULT_KDF,
          authKdf: keys.authKdf,
          wrappedPassphrase,
          wrappedRecovery: base64ToBytes(verified.wrapped_recovery),
        });

        return {
          ...verified,
          token: session.token,
          expires_at: session.expires_at,
          vault_version: session.vault_version,
          kdf: DEFAULT_KDF,
          wrapped_passphrase: bytesToBase64(wrappedPassphrase),
        };
      } catch {
        // Nothing here is worth interrupting a sign-in that has otherwise
        // worked. The data key is unchanged, the vault is unchanged, and the
        // account opens on its old parameters exactly as it did a moment ago.
        return verified;
      }
    },
    [derive],
  );

  const completeSignIn = useCallback(
    async (verified: api.LoginResponse, keys: LoginKeys): Promise<SignInOutcome> => {
      // Both factors are in. This is where the slow derivation finally runs —
      // on the account's own parameters, which the session response carries, so
      // an account made under older ones opens on those rather than on today's.
      let encryptionKey: Uint8Array;
      try {
        encryptionKey = await derive(keys.email, keys.passphrase, verified.kdf);
      } catch (err) {
        // The code is spent and the session issued, but without this key there
        // is nothing to open the vault with. Both factors again is the only way
        // on, and the message has to say so.
        endVerification();
        setError(`${describe(err)} Sign in again.`);
        return { ok: false, reason: 'error' };
      }

      let dataKey: Uint8Array;
      try {
        dataKey = unwrapDataKey(base64ToBytes(verified.wrapped_passphrase), encryptionKey);
      } catch {
        // The auth key made from this passphrase satisfied `/v1/login`, so the
        // passphrase is right and the encryption key made from it should open
        // the wrapped copy. That it does not means the copy was made by
        // something other than this scheme, so say that rather than blaming the
        // passphrase.
        endVerification();
        setError(
          'Signed in, but your key could not be unwrapped. The account may have been created by a different version of the app.',
        );
        return { ok: false, reason: 'error' };
      }

      // The passphrase has now opened the account, which is the one moment a
      // re-wrap is possible. Everything below works from what comes back: if it
      // did upgrade, the token `verified` was holding has just been retired.
      const current = await upgradeStoredKdf(verified, keys, dataKey);

      const remote = await api.getVault(current.token);
      const remoteVault = remote.ciphertext
        ? decryptVault(base64ToBytes(remote.ciphertext), dataKey)
        : null;

      const localVault = await readLocalVault();
      const localKey = await peekDataKey();
      const differentDevice = !localKey || !equalBytes(localKey, dataKey);

      const ready: PendingAdoption = {
        verified: current,
        email: keys.email,
        dataKey,
        remoteVault,
        remoteVersion: remote.version,
        localVault,
      };

      // Codes here that this account has never seen would be gone the moment
      // the remote vault lands on top of them. The session is already issued
      // and the code already spent, so the answer is held here rather than
      // sending the user back through both factors to give it.
      if (remoteVault && localVault && localVault.entries.length > 0 && differentDevice) {
        adoption.current = ready;
        return { ok: false, reason: 'would_replace_local', localCodes: localVault.entries.length };
      }

      return adopt(ready);
    },
    [adopt, derive, endVerification, upgradeStoredKdf],
  );

  const submitCode = useCallback(
    async (raw: string): Promise<SignInOutcome> => {
      const current = pending.current;
      if (!current || inFlight.current) return { ok: false, reason: 'error' };

      const code = normaliseCode(raw);
      if (!isCompleteCode(code)) {
        setError(`Enter the ${VERIFICATION_CODE_LENGTH} digit code from your email.`);
        return { ok: false, reason: 'error' };
      }

      inFlight.current = true;
      setBusy(true);
      setStage('checking');
      setError(null);
      try {
        if (current.keys.purpose === 'register') {
          const keys = current.keys;

          // The derivation had the whole trip to the inbox to itself, so it is
          // usually done and the code goes up with the material below in one
          // request. When the code beats it back, the code is checked on its
          // own first rather than after the wait: the server looks at the code
          // before it looks for the material, so a wrong one comes back now.
          //
          // Waiting first would make every mistyped digit cost the same
          // several seconds as a right one, and — because the screen shows the
          // derivation running — look for all of them as though it had been
          // accepted.
          if (!keys.material.ready()) {
            try {
              await api.checkCode(current.challenge.challengeId, code);
            } catch (err) {
              // Anything but "now send the material" is the code being refused,
              // and the catch below turns it into the message and decides
              // whether the challenge survived it.
              if (!api.isMaterialRequired(err)) throw err;
            }
            // Right, and still unspent. Now the wait below is worth having, and
            // worth saying out loud.
            setStage('finishing');
          }

          let material: RegistrationMaterial;
          try {
            material = await keys.material.promise;
          } catch (err) {
            // The derivation itself failed, which no retry of the code can
            // mend. Back to the start, with the reason.
            endVerification();
            setError(describe(err));
            return { ok: false, reason: 'error' };
          }

          const verified = await api.verifyCode(current.challenge.challengeId, code, {
            authKey: material.authKey,
            kdf: DEFAULT_KDF,
            authKdf: AUTH_KDF,
            wrappedPassphrase: material.wrappedPassphrase,
            wrappedRecovery: material.wrappedRecovery,
          });
          // The usual path skips the check above because the keys were already
          // waiting, which makes this request the one that decides on the code.
          // Past it either way, so what is left is making the account.
          setStage('finishing');
          return await completeRegistration(verified, keys.email, material);
        }

        // A sign-in's verify carries nothing but the code: the account already
        // has its key material, and this device has not derived the half that
        // opens it yet. That happens inside `completeSignIn`, once the six
        // digits have been accepted — a wrong code costs a retry, not a wait.
        const verified = await api.verifyCode(current.challenge.challengeId, code);
        setStage('finishing');
        return await completeSignIn(verified, current.keys);
      } catch (err) {
        setError(describe(err));

        // 429 means the guesses ran out and the server destroyed the challenge;
        // a 410 past the challenge's own deadline means it aged out. Either way
        // there is nothing left to resend against, so the way on is the
        // passphrase again. A 410 before then is just the code expiring, which
        // the screen handles with a new one.
        if (err instanceof api.SyncError) {
          const dead =
            err.status === 429 ||
            (err.status === 410 && nowSeconds() >= current.challenge.expiresAt);
          if (dead) endVerification();
        }
        return { ok: false, reason: 'error' };
      } finally {
        inFlight.current = false;
        setBusy(false);
        setStage(null);
      }
    },
    [completeRegistration, completeSignIn, endVerification],
  );

  const resendCode = useCallback(async (): Promise<boolean> => {
    const current = pending.current;
    if (!current || inFlight.current) return false;

    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      // A new challenge id comes back with it; the previous code is dead from
      // the moment the server issues this one.
      const challenge = await api.resendCode(current.challenge.challengeId);
      beginVerification(challenge, current.keys);
      return true;
    } catch (err) {
      setError(describe(err));
      if (err instanceof api.SyncError && err.status === 410) endVerification();
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [beginVerification, endVerification]);

  const confirmReplaceLocal = useCallback(async (): Promise<boolean> => {
    const ready = adoption.current;
    if (!ready || inFlight.current) return false;

    inFlight.current = true;
    setBusy(true);
    try {
      const outcome = await adopt(ready);
      return outcome.ok;
    } catch (err) {
      setError(describe(err));
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [adopt]);

  const refreshSession = useCallback(async (): Promise<void> => {
    if (state !== 'signed_in') return;

    const live = session.current;
    const email = account?.email ?? null;

    // Either the term ran out while the app was closed, or there was never a
    // token here to begin with. Both mean the account is shut until it is
    // opened with both factors; the codes on the device are not touched.
    if (!live || !sessionIsLive(live, nowSeconds())) {
      await requireSignIn(email);
      return;
    }
    if (!refreshDue(live, nowSeconds())) return;

    try {
      const renewed = await api.refreshSession(live.token);
      await saveSession(toStoredSession({ token: live.token, expires_at: renewed.expires_at }));
    } catch (err) {
      // Only the server saying the session is over is worth acting on. Anything
      // else is a bad connection, and an authenticator that signed people out
      // over a dropped packet would be unusable on a train.
      const rejected = err instanceof api.SyncError && (err.status === 401 || err.status === 403);
      if (rejected) await requireSignIn(email);
    }
  }, [account, requireSignIn, saveSession, state]);

  const signOut = useCallback(async () => {
    const token = session.current?.token;
    session.current = null;

    // Best effort: the local records go either way, so a server that cannot be
    // reached does not trap the user in an account they are trying to leave.
    if (token) await api.logout(token).catch(() => {});

    await Promise.all([
      SecureStore.deleteItemAsync(ACCOUNT_KEY),
      SecureStore.deleteItemAsync(SESSION_KEY),
    ]);

    endVerification();
    setAccount(null);
    setPendingRecoveryKey(null);
    setError(null);
    // Leaving on purpose, so nothing is held back for the next screen — not even
    // the address, which a shared device has no business remembering.
    setLastEmail(null);
    setSessionExpired(false);
    setState('signed_out');
  }, [endVerification]);

  // Restore what is stored, then fall back to the development auto sign-in.
  useEffect(() => {
    let active = true;

    void (async () => {
      const [storedAccount, storedSession] = await Promise.all([
        SecureStore.getItemAsync(ACCOUNT_KEY)
          .then(parseStoredAccount)
          .catch(() => null),
        SecureStore.getItemAsync(SESSION_KEY)
          .then(parseStoredSession)
          .catch(() => null),
      ]);
      if (!active) return;

      if (storedAccount && sessionIsLive(storedSession, nowSeconds())) {
        session.current = storedSession;
        setLastEmail(storedAccount.email);
        setAccount(storedAccount);
        setState('signed_in');
        return;
      }

      if (storedAccount) {
        // Enrolled, but the term ran out while the app was closed. The vault
        // stays where it is; what is gone is the right to use the account, and
        // that comes back through both factors.
        session.current = null;
        setLastEmail(storedAccount.email);
        setSessionExpired(true);
      }

      const automatic = devAutoLogin(
        process.env.EXPO_PUBLIC_DEV_AUTO_LOGIN,
        process.env.EXPO_PUBLIC_DEV_ACCOUNT_EMAIL,
        process.env.EXPO_PUBLIC_DEV_ACCOUNT_PASSPHRASE,
      );
      if (!automatic) {
        setState('signed_out');
        return;
      }

      // Show the gate first: the derivation takes seconds, and a blank screen
      // for that long reads as a hang.
      setState('signed_out');
      // This gets as far as the code screen and stops. There is no way past the
      // second factor that does not involve reading the email, which is the
      // whole point of it — what this saves is the passphrase and the Argon2id
      // wait on every reload, not the code.
      const outcome = await signIn(automatic.email, automatic.passphrase);
      if (!active || outcome.ok) return;

      // First run against a fresh server, most likely. Create the account so a
      // clean checkout needs no manual setup.
      await register(automatic.email, automatic.passphrase);
    })();

    return () => {
      active = false;
    };
    // Runs once. `signIn` and `register` are stable for the provider's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<AccountContextValue>(
    () => ({
      state,
      account,
      lastEmail,
      sessionExpired,
      busy,
      stage,
      progress,
      error,
      pendingVerification,
      pendingRecoveryKey,
      acknowledgeRecoveryKey: () => setPendingRecoveryKey(null),
      register,
      signIn,
      submitCode,
      resendCode,
      cancelVerification,
      confirmReplaceLocal,
      refreshSession,
      signOut,
      clearError: () => setError(null),
    }),
    [
      state,
      account,
      lastEmail,
      sessionExpired,
      busy,
      stage,
      progress,
      error,
      pendingVerification,
      pendingRecoveryKey,
      register,
      signIn,
      submitCode,
      resendCode,
      cancelVerification,
      confirmReplaceLocal,
      refreshSession,
      signOut,
    ],
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountContextValue {
  const ctx = useContext(AccountContext);
  if (!ctx) throw new Error('useAccount must be used inside an AccountProvider');
  return ctx;
}
