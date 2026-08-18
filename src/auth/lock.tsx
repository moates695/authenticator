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
import { AppState } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import { probeLockCapability, requestUnlock } from './device_auth';
import {
  LOCK_PREFERENCE_KEY,
  lockApplies,
  lockDisabledByBuild,
  locksOnStateChange,
  parseLockPreference,
  serialiseLockPreference,
  unlockMessage,
  type LockCapability,
} from './lock_policy';

const UNLOCK_REASON = 'Unlock Authenticator';
const DISABLE_REASON = 'Confirm it is you to turn off the app lock';

/** Stand-in until the device has been asked what it can do. */
const UNKNOWN_CAPABILITY: LockCapability = { method: 'none', label: 'Screen lock' };

export type LockState =
  /** Still reading the preference and probing the device. Nothing is shown yet. */
  | 'checking'
  | 'locked'
  | 'unlocked';

type LockContextValue = {
  state: LockState;
  /** What the device can challenge with. `none` until the probe comes back. */
  capability: LockCapability;
  /** The user's preference, whether or not it is in force. */
  enabled: boolean;
  /** True when this build turns the lock off regardless of the preference. */
  disabledByBuild: boolean;
  /** Set after an attempt the user should hear about; cleared on the next one. */
  error: string | null;
  /** Raises the system prompt. Resolves to whether the app is now open. */
  unlock: () => Promise<boolean>;
  /**
   * Changes the preference. Turning the lock off asks for the device check
   * first, and resolves false if that is not passed.
   */
  setEnabled: (next: boolean) => Promise<boolean>;
};

const LockContext = createContext<LockContextValue | null>(null);

/**
 * Holds the app behind the device's own unlock check.
 *
 * The lock is re-armed whenever the app is backgrounded, so it guards handing
 * the phone over as well as picking it up — an authenticator that only asked
 * once at launch would be open for the rest of the day.
 *
 * It only applies while there is an account to guard. `guarded` says whether
 * there is one, and `null` means the caller does not know yet — the lock waits
 * rather than guessing, since guessing either way shows the wrong screen first.
 *
 * That the lock is decided once per launch is deliberate: signing in during a
 * run does not raise a prompt, because the passphrase and an emailed code have
 * just been given and asking for a finger on top of them is asking twice.
 */
export function LockProvider({
  guarded,
  children,
}: {
  guarded: boolean | null;
  children: ReactNode;
}) {
  const [state, setState] = useState<LockState>('checking');
  const [capability, setCapability] = useState<LockCapability>(UNKNOWN_CAPABILITY);
  const [enabled, setEnabledState] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const disabledByBuild = useMemo(
    () => lockDisabledByBuild(process.env.EXPO_PUBLIC_DISABLE_APP_LOCK),
    [],
  );

  // The background listener and the prompt guard both read these outside of a
  // render, where React state would be a frame behind.
  const capabilityRef = useRef<LockCapability>(UNKNOWN_CAPABILITY);
  const enabledRef = useRef(true);
  const guardedRef = useRef<boolean | null>(guarded);
  const appliesRef = useRef(false);
  /** True once the device has been probed and the preference read back. */
  const probed = useRef(false);
  /** True once the launch has been settled as locked or unlocked. */
  const decided = useRef(false);
  /**
   * True from raising a prompt until the app is next reported active. Held that
   * long because the prompt can itself push the app out of the foreground, and
   * the resulting background event must not re-lock the app that raised it.
   */
  const promptOpen = useRef(false);
  /** The attempt in flight, so a double tap cannot stack two system prompts. */
  const attempt = useRef<Promise<boolean> | null>(null);

  const recomputeApplies = useCallback(() => {
    appliesRef.current = lockApplies({
      disabledByBuild,
      guarded: guardedRef.current === true,
      enabled: enabledRef.current,
      capability: capabilityRef.current,
    });
  }, [disabledByBuild]);

  const publishCapability = useCallback(
    (next: LockCapability) => {
      capabilityRef.current = next;
      recomputeApplies();
      setCapability(next);
    },
    [recomputeApplies],
  );

  const publishEnabled = useCallback(
    (next: boolean) => {
      enabledRef.current = next;
      recomputeApplies();
      setEnabledState(next);
    },
    [recomputeApplies],
  );

  /**
   * Settles what the launch should show, once the device has answered and the
   * caller knows whether anyone is signed in.
   *
   * Only the first call arms the lock. After that the state belongs to the
   * background listener, with one exception: an app that stops having anything
   * to guard — a sign-out, or a session that ran out — must lift the cover,
   * because the sign-in screen underneath it has to be reachable.
   */
  const decide = useCallback(() => {
    if (!probed.current || guardedRef.current === null) return;

    if (!decided.current) {
      decided.current = true;
      setState(appliesRef.current ? 'locked' : 'unlocked');
      return;
    }
    if (!appliesRef.current) {
      setError(null);
      setState('unlocked');
    }
  }, []);

  useEffect(() => {
    let active = true;

    void (async () => {
      const [raw, capability] = await Promise.all([
        SecureStore.getItemAsync(LOCK_PREFERENCE_KEY).catch(() => null),
        probeLockCapability(),
      ]);
      if (!active) return;

      publishCapability(capability);
      publishEnabled(parseLockPreference(raw));
      probed.current = true;
      decide();
    })();

    return () => {
      active = false;
    };
  }, [decide, publishCapability, publishEnabled]);

  // Tracked through a ref as well as the prop, because the background listener
  // and the unlock path both read it outside a render.
  useEffect(() => {
    guardedRef.current = guarded;
    recomputeApplies();
    decide();
  }, [guarded, decide, recomputeApplies]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        promptOpen.current = false;
        return;
      }
      if (!appliesRef.current) return;
      if (locksOnStateChange(next, promptOpen.current)) {
        setState('locked');
        // The last screen's error belongs to the last visit.
        setError(null);
      }
    });

    return () => subscription.remove();
  }, []);

  /** Raises one system prompt, keeping the background listener out of its way. */
  const prompt = useCallback(async (reason: string) => {
    promptOpen.current = true;
    try {
      return await requestUnlock(capabilityRef.current, reason);
    } finally {
      // If the app is already back in the foreground there is no later 'active'
      // event coming to clear this.
      if (AppState.currentState === 'active') promptOpen.current = false;
    }
  }, []);

  const runUnlock = useCallback(async (): Promise<boolean> => {
    const cap = capabilityRef.current;
    const outcome = await prompt(UNLOCK_REASON);

    if (outcome === 'unavailable') {
      // The enrolment has gone since we probed. Ask again rather than trusting
      // a single unavailable: only a device with no screen lock at all is let
      // through, because there is no longer any check that could be passed.
      const reprobed = await probeLockCapability();
      publishCapability(reprobed);
      if (reprobed.method === 'none') {
        setError(null);
        setState('unlocked');
        return true;
      }
      setError(unlockMessage('unavailable', reprobed));
      return false;
    }

    setError(unlockMessage(outcome, cap));
    if (outcome !== 'success') return false;

    setState('unlocked');
    return true;
  }, [prompt, publishCapability]);

  const unlock = useCallback((): Promise<boolean> => {
    if (attempt.current) return attempt.current;

    const running = runUnlock().finally(() => {
      attempt.current = null;
    });
    attempt.current = running;
    return running;
  }, [runUnlock]);

  const setEnabled = useCallback(
    async (next: boolean): Promise<boolean> => {
      const cap = capabilityRef.current;

      // Turning the lock off is the only change here that weakens anything, so
      // it has to come from whoever can pass the check rather than from whoever
      // is holding an already-open phone.
      if (!next && appliesRef.current) {
        const outcome = await prompt(DISABLE_REASON);
        if (outcome !== 'success') {
          setError(unlockMessage(outcome, cap));
          return false;
        }
      }

      setError(null);
      publishEnabled(next);
      // A preference that failed to save is worth surfacing: the user would
      // otherwise believe the lock is off and find it back on next launch.
      try {
        await SecureStore.setItemAsync(LOCK_PREFERENCE_KEY, serialiseLockPreference(next));
      } catch {
        setError('Could not save that setting.');
      }
      return true;
    },
    [prompt, publishEnabled],
  );

  const value = useMemo<LockContextValue>(
    () => ({ state, capability, enabled, disabledByBuild, error, unlock, setEnabled }),
    [state, capability, enabled, disabledByBuild, error, unlock, setEnabled],
  );

  return <LockContext.Provider value={value}>{children}</LockContext.Provider>;
}

export function useAppLock(): LockContextValue {
  const ctx = useContext(LockContext);
  if (!ctx) throw new Error('useAppLock must be used inside a LockProvider');
  return ctx;
}
