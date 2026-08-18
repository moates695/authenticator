import { useEffect } from 'react';
import { AppState } from 'react-native';

import { useAppLock } from '@/auth/lock';
import { useAccount } from './account';

/**
 * Renews the sign-in whenever the app is open and the device check has been
 * passed. Renders nothing.
 *
 * This is what the app lock is worth beyond keeping a handed-over phone shut.
 * The emailed code proves the address once, when the device is adopted; after
 * that the thing standing between somebody holding the phone and the codes is
 * the fingerprint or passcode, and passing it is the best evidence available
 * that the owner is here. So that, and not a calendar, is what keeps the session
 * alive — a phone in daily use is never asked for a code again, and one that
 * goes quiet for a fortnight is.
 *
 * A device with no screen lock enrolled has no check to offer, so opening the
 * app is all the renewal gets. That is the same trade the lock itself makes:
 * there is nothing to verify against, and refusing would strand somebody's codes
 * behind a prompt that can never be satisfied.
 *
 * It sits here rather than inside the provider so the account has no opinion
 * about the lock: one knows when the device was unlocked, the other knows what
 * to do about it, and this is the wire between them.
 */
export function SessionKeeper() {
  const { state } = useAppLock();
  const { refreshSession } = useAccount();

  useEffect(() => {
    if (state !== 'unlocked') return;

    // Two triggers, because either alone leaves a gap. The effect re-running on
    // 'unlocked' covers a phone that re-locks every time it is put down; the
    // foreground event covers a device or build where the lock never applies,
    // so the state would otherwise sit at 'unlocked' and never change again.
    void refreshSession();

    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refreshSession();
    });
    return () => subscription.remove();
  }, [state, refreshSession]);

  return null;
}
