import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';

import {
  capabilityFrom,
  outcomeFor,
  type LockCapability,
  type UnlockOutcome,
} from './lock_policy';

/** The platform side of the app lock. The rules it applies live in `lock_policy`. */

/**
 * Asks the device what it can authenticate with.
 *
 * Treats any failure as "nothing enrolled" rather than throwing: the caller's
 * only use for this is deciding whether to raise a prompt, and a device that
 * cannot answer the question is not going to answer the prompt either.
 */
export async function probeLockCapability(): Promise<LockCapability> {
  try {
    const [level, types] = await Promise.all([
      LocalAuthentication.getEnrolledLevelAsync(),
      LocalAuthentication.supportedAuthenticationTypesAsync(),
    ]);
    return capabilityFrom(level, types, Platform.OS);
  } catch {
    return capabilityFrom(LocalAuthentication.SecurityLevel.NONE, [], Platform.OS);
  }
}

/**
 * Raises the system unlock prompt and reports how it went.
 *
 * @param reason shown above the prompt, so an unexpected one is explained.
 */
export async function requestUnlock(
  capability: LockCapability,
  reason: string,
): Promise<UnlockOutcome> {
  if (capability.method === 'none') return 'unavailable';

  try {
    return outcomeFor(
      await LocalAuthentication.authenticateAsync({
        promptMessage: reason,
        cancelLabel: 'Cancel',
        // The device passcode stays available as a fallback. Without it, a
        // wet or unrecognised finger would lock the user out of their own
        // codes with no way back in.
        disableDeviceFallback: false,
        // Android only. A vault of one-time codes is worth holding to Class 3
        // biometrics; weaker face unlock drops through to the passcode above.
        biometricsSecurityLevel: 'strong',
        // Android only, and on by default. An extra "confirm" tap after a
        // successful scan is friction on a screen whose only purpose is to get
        // out of the way.
        requireConfirmation: false,
      }),
    );
  } catch {
    // The module rejects rather than resolving for a few native-side faults.
    return 'failed';
  }
}
