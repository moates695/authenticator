import {
  AuthenticationType,
  SecurityLevel,
  type LocalAuthenticationResult,
} from 'expo-local-authentication';
import { type AppStateStatus } from 'react-native';

/**
 * The rules behind the app lock, kept apart from the platform calls in
 * `device_auth.ts` so each one can be checked on its own.
 *
 * The lock is a gate on opening the app, not a second layer of encryption: the
 * vault key already lives in the platform keystore and is released only while
 * the device itself is unlocked. What this adds is that a phone handed over
 * already unlocked still will not show anyone's codes.
 */

/** Where the lock preference is kept. Outside the vault: it is device-local. */
export const LOCK_PREFERENCE_KEY = 'app_lock_enabled';

/**
 * Build-time off switch, read from `EXPO_PUBLIC_DISABLE_APP_LOCK`. Expo inlines
 * `EXPO_PUBLIC_*` at bundle time, so this is fixed for a given build.
 *
 * This exists for local testing, where a simulator may have no enrolled finger
 * and dropping to a passcode prompt on every reload gets old fast. It is
 * separate from the user-facing setting on purpose: a build that ships without
 * the variable set cannot have the lock disabled by anything but the user.
 */
export function lockDisabledByBuild(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true';
}

/**
 * Reads back the stored preference. Anything other than an explicit "off" —
 * including a first run, with nothing stored — leaves the lock on: a code vault
 * that opens for whoever is holding the phone is not much of a vault.
 */
export function parseLockPreference(raw: string | null): boolean {
  return raw !== 'false';
}

export function serialiseLockPreference(enabled: boolean): string {
  return enabled ? 'true' : 'false';
}

/** What the device will actually challenge the user with. */
export type LockMethod =
  /** A finger, face or iris the user has enrolled. */
  | 'biometric'
  /** No biometrics enrolled, but there is a PIN, pattern or passcode to fall back on. */
  | 'passcode'
  /** No device security at all, so there is nothing for us to check against. */
  | 'none';

export type LockCapability = {
  method: LockMethod;
  /** What to call the check in prompts and settings copy, e.g. "Fingerprint". */
  label: string;
};

/**
 * Names the check the way the platform names it, so the settings row matches
 * what the user sees in their own system settings.
 *
 * Fingerprint wins over face when both are enrolled: it is the faster of the
 * two to present, and on Android it is the one that is reliably Class 3.
 */
function biometricLabel(types: readonly AuthenticationType[], ios: boolean): string {
  if (types.includes(AuthenticationType.FINGERPRINT)) return ios ? 'Touch ID' : 'Fingerprint';
  if (types.includes(AuthenticationType.FACIAL_RECOGNITION)) return ios ? 'Face ID' : 'Face unlock';
  if (types.includes(AuthenticationType.IRIS)) return 'Iris unlock';
  // Enrolled biometrics of a kind this version of the OS did not name.
  return 'Biometrics';
}

/**
 * Works out what the lock can ask for, from what the device reports.
 *
 * `SecurityLevel` describes what is *enrolled*, not what hardware exists, which
 * is the question that matters here: a fingerprint reader with no finger
 * registered against it cannot authenticate anybody.
 */
export function capabilityFrom(
  level: SecurityLevel,
  types: readonly AuthenticationType[],
  platform: string,
): LockCapability {
  const ios = platform === 'ios';

  // BIOMETRIC_WEAK and the deprecated BIOMETRIC share the value 2, so anything
  // at or above it means some biometric is enrolled.
  if (level >= SecurityLevel.BIOMETRIC_WEAK) {
    return { method: 'biometric', label: biometricLabel(types, ios) };
  }
  if (level === SecurityLevel.SECRET) {
    return { method: 'passcode', label: ios ? 'Passcode' : 'Screen lock' };
  }
  return { method: 'none', label: ios ? 'Passcode' : 'Screen lock' };
}

/** The outcome of one unlock attempt, reduced to the cases we act on. */
export type UnlockOutcome =
  | 'success'
  /** The user backed out. Not an error; we just stay locked, quietly. */
  | 'cancelled'
  /** Too many wrong attempts — the OS is refusing to ask again for now. */
  | 'lockout'
  /** Nothing is enrolled to check against any more. */
  | 'unavailable'
  /** A wrong finger or face, or something we cannot classify. */
  | 'failed';

export function outcomeFor(result: LocalAuthenticationResult): UnlockOutcome {
  if (result.success) return 'success';

  switch (result.error) {
    case 'user_cancel':
    case 'app_cancel':
    case 'system_cancel':
    // Raised when the user asks for the passcode fallback and we have disabled
    // it. We leave the fallback on, so this is only reachable if the platform
    // declines it, which leaves the user exactly where a cancel would.
    case 'user_fallback':
      return 'cancelled';
    case 'lockout':
      return 'lockout';
    case 'not_enrolled':
    case 'not_available':
    case 'passcode_not_set':
    case 'no_space':
      return 'unavailable';
    default:
      return 'failed';
  }
}

/**
 * What to put on the lock screen after a failed attempt. A cancel says nothing:
 * the user knows they cancelled, and an error for it reads as an accusation.
 */
export function unlockMessage(outcome: UnlockOutcome, capability: LockCapability): string | null {
  switch (outcome) {
    case 'success':
    case 'cancelled':
      return null;
    case 'lockout':
      return `Too many attempts. Unlock your device to reset ${capability.label}, then try again.`;
    case 'unavailable':
      return `${capability.label} is no longer set up on this device.`;
    case 'failed':
      return 'Not recognised. Try again.';
  }
}

/**
 * Whether an app state change should throw the lock back on.
 *
 * Only a real backgrounding counts. 'inactive' fires for things that leave the
 * app on screen and in the user's hands — the notification shade, a system
 * alert, the app switcher being flicked through — and locking on those would
 * mean a prompt after every stray swipe.
 *
 * `authInFlight` covers the case that would otherwise deadlock us: on some
 * platforms the biometric prompt itself pushes the app out of the foreground,
 * so a prompt could re-lock the app that raised it and immediately ask again.
 */
export function locksOnStateChange(next: AppStateStatus, authInFlight: boolean): boolean {
  if (authInFlight) return false;
  return next === 'background';
}

/**
 * Whether the app is on screen, and so can raise a prompt without it landing
 * over whatever the user switched to.
 *
 * Phrased as "not away" rather than "is active" because the state reads
 * 'unknown' for a moment on some cold starts; treating that as backgrounded
 * would leave the lock screen waiting for an 'active' event that has already
 * been and gone.
 */
export function isForeground(status: AppStateStatus): boolean {
  return status !== 'background' && status !== 'inactive';
}

/**
 * Whether the app should sit behind the lock at all, given whether there is an
 * account to guard, the build flag, the user's preference and what the device
 * can actually ask for.
 *
 * A device with no screen lock is let through rather than shut out: there is no
 * check to make, and refusing to open would strand the user's codes behind a
 * prompt that can never be satisfied.
 *
 * A signed-out app is let through for a different reason: there is nothing
 * behind the lock yet. The vault is unreadable without the account's data key,
 * so all a fingerprint would buy is a prompt in front of the sign-in screen —
 * and one that a new user, who has never been told this app has a lock, would
 * meet before anything else.
 */
export function lockApplies({
  disabledByBuild,
  guarded,
  enabled,
  capability,
}: {
  disabledByBuild: boolean;
  /** Whether there is a signed-in account behind the lock. */
  guarded: boolean;
  enabled: boolean;
  capability: LockCapability;
}): boolean {
  return guarded && !disabledByBuild && enabled && capability.method !== 'none';
}
