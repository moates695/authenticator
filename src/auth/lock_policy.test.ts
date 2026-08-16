import { AuthenticationType, SecurityLevel } from 'expo-local-authentication';

import {
  capabilityFrom,
  isForeground,
  lockApplies,
  lockDisabledByBuild,
  locksOnStateChange,
  outcomeFor,
  parseLockPreference,
  serialiseLockPreference,
  unlockMessage,
  type LockCapability,
} from './lock_policy';

const biometric: LockCapability = { method: 'biometric', label: 'Fingerprint' };
const unsecured: LockCapability = { method: 'none', label: 'Screen lock' };

describe('lockDisabledByBuild', () => {
  it('is off unless the build sets the variable', () => {
    expect(lockDisabledByBuild(undefined)).toBe(false);
    expect(lockDisabledByBuild('')).toBe(false);
    expect(lockDisabledByBuild('0')).toBe(false);
    expect(lockDisabledByBuild('false')).toBe(false);
  });

  it('accepts the two spellings a shell is likely to produce', () => {
    expect(lockDisabledByBuild('1')).toBe(true);
    expect(lockDisabledByBuild('true')).toBe(true);
  });
});

describe('parseLockPreference', () => {
  it('locks on a first run, with nothing stored yet', () => {
    expect(parseLockPreference(null)).toBe(true);
  });

  it('reads back what was written', () => {
    expect(parseLockPreference(serialiseLockPreference(false))).toBe(false);
    expect(parseLockPreference(serialiseLockPreference(true))).toBe(true);
  });

  it('stays locked on an unreadable value rather than opening up', () => {
    expect(parseLockPreference('yes please')).toBe(true);
    expect(parseLockPreference('')).toBe(true);
  });
});

describe('capabilityFrom', () => {
  it('has nothing to check when no screen lock is enrolled', () => {
    expect(capabilityFrom(SecurityLevel.NONE, [AuthenticationType.FINGERPRINT], 'android')).toEqual(
      { method: 'none', label: 'Screen lock' },
    );
  });

  it('falls back to the passcode when hardware exists but no biometric is enrolled', () => {
    expect(capabilityFrom(SecurityLevel.SECRET, [AuthenticationType.FACIAL_RECOGNITION], 'ios')).toEqual(
      { method: 'passcode', label: 'Passcode' },
    );
  });

  it('names the biometric the way the platform does', () => {
    expect(
      capabilityFrom(SecurityLevel.BIOMETRIC_STRONG, [AuthenticationType.FINGERPRINT], 'ios').label,
    ).toBe('Touch ID');
    expect(
      capabilityFrom(SecurityLevel.BIOMETRIC_STRONG, [AuthenticationType.FINGERPRINT], 'android')
        .label,
    ).toBe('Fingerprint');
    expect(
      capabilityFrom(SecurityLevel.BIOMETRIC_STRONG, [AuthenticationType.FACIAL_RECOGNITION], 'ios')
        .label,
    ).toBe('Face ID');
  });

  it('prefers the fingerprint when both are enrolled', () => {
    const both = [AuthenticationType.FACIAL_RECOGNITION, AuthenticationType.FINGERPRINT];
    expect(capabilityFrom(SecurityLevel.BIOMETRIC_STRONG, both, 'android').label).toBe(
      'Fingerprint',
    );
  });

  it('treats a weak biometric as biometric, since that is what will be asked for', () => {
    expect(
      capabilityFrom(SecurityLevel.BIOMETRIC_WEAK, [AuthenticationType.FACIAL_RECOGNITION], 'android'),
    ).toEqual({ method: 'biometric', label: 'Face unlock' });
  });

  it('still reports a biometric when the enrolled kind is one it cannot name', () => {
    expect(capabilityFrom(SecurityLevel.BIOMETRIC_STRONG, [], 'android')).toEqual({
      method: 'biometric',
      label: 'Biometrics',
    });
  });
});

describe('outcomeFor', () => {
  it('passes a successful check', () => {
    expect(outcomeFor({ success: true })).toBe('success');
  });

  it('treats every kind of backing out as a cancel', () => {
    for (const error of ['user_cancel', 'app_cancel', 'system_cancel', 'user_fallback'] as const) {
      expect(outcomeFor({ success: false, error })).toBe('cancelled');
    }
  });

  it('separates a lockout, which retrying will not fix', () => {
    expect(outcomeFor({ success: false, error: 'lockout' })).toBe('lockout');
  });

  it('reports a vanished enrolment as unavailable', () => {
    for (const error of ['not_enrolled', 'not_available', 'passcode_not_set', 'no_space'] as const) {
      expect(outcomeFor({ success: false, error })).toBe('unavailable');
    }
  });

  it('treats a wrong or unclassifiable result as a plain failure', () => {
    expect(outcomeFor({ success: false, error: 'authentication_failed' })).toBe('failed');
    expect(outcomeFor({ success: false, error: 'unknown' })).toBe('failed');
    expect(outcomeFor({ success: false, error: 'timeout' })).toBe('failed');
  });
});

describe('unlockMessage', () => {
  it('says nothing about a cancel, which the user did on purpose', () => {
    expect(unlockMessage('cancelled', biometric)).toBeNull();
    expect(unlockMessage('success', biometric)).toBeNull();
  });

  it('names the check in the messages that mention it', () => {
    expect(unlockMessage('lockout', biometric)).toContain('Fingerprint');
    expect(unlockMessage('unavailable', biometric)).toContain('Fingerprint');
  });

  it('has something to show for every failing outcome', () => {
    expect(unlockMessage('failed', biometric)).toBeTruthy();
  });
});

describe('locksOnStateChange', () => {
  it('locks when the app is actually backgrounded', () => {
    expect(locksOnStateChange('background', false)).toBe(true);
  });

  it('leaves the app open for states that keep it in the user’s hands', () => {
    expect(locksOnStateChange('inactive', false)).toBe(false);
    expect(locksOnStateChange('active', false)).toBe(false);
  });

  it('ignores the backgrounding caused by the unlock prompt itself', () => {
    expect(locksOnStateChange('background', true)).toBe(false);
  });
});

describe('isForeground', () => {
  it('is true while the app is on screen', () => {
    expect(isForeground('active')).toBe(true);
  });

  it('is false while the app is away', () => {
    expect(isForeground('background')).toBe(false);
    expect(isForeground('inactive')).toBe(false);
  });

  it('assumes on screen for a state it does not recognise, so a cold start still prompts', () => {
    expect(isForeground('unknown')).toBe(true);
  });
});

describe('lockApplies', () => {
  const applies = (overrides: Partial<Parameters<typeof lockApplies>[0]> = {}) =>
    lockApplies({
      disabledByBuild: false,
      guarded: true,
      enabled: true,
      capability: biometric,
      ...overrides,
    });

  it('locks when someone is signed in, it is enabled and the device can check', () => {
    expect(applies()).toBe(true);
  });

  it('is off when the user has turned it off', () => {
    expect(applies({ enabled: false })).toBe(false);
  });

  it('is off when the build overrides it, whatever the preference says', () => {
    expect(applies({ disabledByBuild: true })).toBe(false);
  });

  it('lets a device with no screen lock through rather than stranding the codes', () => {
    expect(applies({ capability: unsecured })).toBe(false);
  });

  it('is off while nobody is signed in, since there is nothing behind it', () => {
    expect(applies({ guarded: false })).toBe(false);
    expect(applies({ guarded: false, enabled: true, capability: biometric })).toBe(false);
  });
});
