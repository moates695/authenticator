import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Field, Input, SecretInput, SegmentedControl } from '@/components/form';
import { KeyboardAwareScrollView } from '@/components/keyboard';
import { useTheme } from '@/theme/theme_context';
import { useAccount } from './account';
import {
  MIN_PASSPHRASE_LENGTH,
  isValidEmail,
  passphraseProblem,
  passphraseStrength,
  type PassphraseTier,
} from './account_policy';
import { SYNC_BASE_URL } from './api';

type Mode = 'sign-in' | 'create';

/**
 * The gate. Nothing behind it is mounted until there is an account, which is
 * deliberate: the vault's data key comes from the account, so there is no
 * halfway state where codes exist on the device but nowhere else.
 *
 * Neither button here signs anyone in. Both end at a code sent to the address
 * given, which `VerifyEmailScreen` takes from there — the passphrase is one
 * factor of two, and this screen only collects the first.
 */
export function SignInScreen() {
  const { colors, spacing, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const account = useAccount();

  const [mode, setMode] = useState<Mode>('sign-in');
  // Filled in when a session ran out on a device that is still enrolled. The
  // address is the one part of getting back in that is not a secret.
  const [email, setEmail] = useState(account.lastEmail ?? '');
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  /** Local validation, kept apart from the provider's error so neither clobbers the other. */
  const [problem, setProblem] = useState<string | null>(null);

  const creating = mode === 'create';
  const message = problem ?? account.error;

  const switchMode = (next: Mode) => {
    setMode(next);
    setProblem(null);
    setConfirmation('');
    account.clearError();
  };

  const submit = async () => {
    if (account.busy) return;

    if (!isValidEmail(email)) {
      setProblem('That does not look like an email address.');
      return;
    }
    const passphraseIssue = passphraseProblem(passphrase, creating ? confirmation : undefined);
    if (passphraseIssue) {
      setProblem(passphraseIssue);
      return;
    }

    setProblem(null);
    account.clearError();

    // Both of these end at a code in the user's inbox rather than a session, so
    // there is nothing to do with the result here: the gate swaps this screen
    // for the code screen the moment a challenge is outstanding.
    if (creating) {
      await account.register(email, passphrase);
      return;
    }
    await account.signIn(email, passphrase);
  };

  return (
    <View style={[StyleSheet.absoluteFillObject, styles.cover, { backgroundColor: colors.bg }]}>
      <KeyboardAwareScrollView
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          padding: spacing.xl,
          paddingTop: insets.top + spacing.xl,
          paddingBottom: insets.bottom + spacing.xl,
          gap: spacing.lg,
        }}
      >
        <View style={{ alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm }}>
          <View
            style={{
              width: 64,
              height: 64,
              borderRadius: 32,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: colors.accentSoft,
            }}
          >
            <Ionicons name="cloud-done-outline" size={30} color={colors.accent} />
          </View>
          <Text style={{ color: colors.text, fontSize: 20, fontWeight: '700' }}>
            {creating ? 'Create your account' : 'Sign in'}
          </Text>
          <Text
            style={{
              color: colors.textMuted,
              fontSize: 14,
              lineHeight: 20,
              textAlign: 'center',
              maxWidth: 320,
            }}
          >
            {creating
              ? 'Your codes are encrypted on this device and then sent to the server.'
              : 'Signing in loads codes from your encrypted backup.'}
          </Text>
        </View>

        {account.sessionExpired && !creating ? (
          <View
            style={{
              backgroundColor: colors.surface,
              borderRadius: radius.md,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: colors.border,
              padding: spacing.md,
              gap: spacing.xs,
            }}
          >
            <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }}>
              Signed out
            </Text>
            <Text style={{ color: colors.textMuted, fontSize: 13, lineHeight: 19 }}>
              Authenticator has not been opened for a couple of weeks, so it needs both factors
              again. Your codes are still on this device.
            </Text>
          </View>
        ) : null}

        <SegmentedControl<Mode>
          options={[
            { value: 'sign-in', label: 'Sign in' },
            { value: 'create', label: 'Create account' },
          ]}
          value={mode}
          onChange={switchMode}
        />

        <Field label="Email">
          <Input
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            keyboardType="email-address"
            textContentType="emailAddress"
            editable={!account.busy}
          />
        </Field>

        <Field
          label="Passphrase"
          hint={
            creating
              ? `At least ${MIN_PASSPHRASE_LENGTH} characters. There is no way to reset this — it is what your backup is encrypted with.`
              : undefined
          }
        >
          <SecretInput
            // Remounts on a mode switch, so a passphrase revealed on one form
            // is masked again on the other.
            key={mode}
            secret="passphrase"
            value={passphrase}
            onChangeText={setPassphrase}
            placeholder="Your passphrase"
            autoCapitalize="none"
            autoComplete={creating ? 'new-password' : 'current-password'}
            textContentType={creating ? 'newPassword' : 'password'}
            editable={!account.busy}
          />
          {creating ? <StrengthMeter passphrase={passphrase} /> : null}
        </Field>

        {creating ? (
          <Field label="Confirm passphrase">
            <SecretInput
              secret="passphrase confirmation"
              value={confirmation}
              onChangeText={setConfirmation}
              placeholder="Type it again"
              autoCapitalize="none"
              autoComplete="new-password"
              textContentType="newPassword"
              editable={!account.busy}
            />
          </Field>
        ) : null}

        {message ? (
          <Text style={{ color: colors.danger, fontSize: 13, lineHeight: 19 }}>{message}</Text>
        ) : null}

        <Pressable
          onPress={() => void submit()}
          disabled={account.busy}
          accessibilityRole="button"
          accessibilityState={{ disabled: account.busy }}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: spacing.sm,
            backgroundColor: colors.accent,
            borderRadius: radius.pill,
            paddingVertical: spacing.md,
            opacity: pressed || account.busy ? 0.75 : 1,
          })}
        >
          {account.busy ? <ActivityIndicator size="small" color="#FFFFFF" /> : null}
          <Text style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '600' }}>
            {account.busy ? busyLabel(creating) : creating ? 'Create account' : 'Sign in'}
          </Text>
        </Pressable>

        <Text
          style={{
            color: colors.textFaint,
            fontSize: 12,
            lineHeight: 18,
            textAlign: 'center',
          }}
        >
          We will email you a code to confirm it is you.
          {'\n'}Backing up to {hostOf(SYNC_BASE_URL)}
        </Text>
      </KeyboardAwareScrollView>
    </View>
  );
}

/**
 * Four segments and a word, recomputed on every keystroke. The barrier itself
 * lives in `passphraseProblem` — this is the same verdict shown before the
 * button is pressed, so a blocked passphrase is never a surprise at submit.
 */
function StrengthMeter({ passphrase }: { passphrase: string }) {
  const { colors, spacing, radius } = useTheme();

  if (passphrase.length === 0) return null;

  const tier = passphraseStrength(passphrase);
  const levels: Record<PassphraseTier, { colour: string; filled: number; label: string }> = {
    blocked: { colour: colors.danger, filled: 1, label: 'Not strong enough to use' },
    weak: { colour: colors.warn, filled: 2, label: 'Weak — okay, but a longer one would be safer' },
    good: { colour: colors.success, filled: 3, label: 'Good' },
    superior: { colour: colors.superior, filled: 4, label: 'Superior' },
  };
  const { colour, filled, label } = levels[tier];

  return (
    <View
      accessibilityLabel={`Passphrase strength: ${label}`}
      style={{ gap: spacing.xs, marginTop: spacing.xs }}
    >
      <View style={{ flexDirection: 'row', gap: spacing.xs }}>
        {[0, 1, 2, 3].map((segment) => (
          <View
            key={segment}
            style={{
              flex: 1,
              height: 4,
              borderRadius: radius.pill,
              backgroundColor: segment < filled ? colour : colors.surfaceAlt,
            }}
          />
        ))}
      </View>
      <Text style={{ color: colour, fontSize: 12, lineHeight: 18 }}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  cover: {
    // Android draws by elevation rather than child order, so the gate needs both
    // to stay reliably on top of the navigator it is covering.
    zIndex: 5,
    elevation: 16,
  },
});

/**
 * Neither of these is the slow derivation any more — that one runs on the code
 * screen, once both factors are in. Signing in stretches the passphrase into the
 * light auth key and sends it; creating an account sends nothing but the
 * address. Both are a round trip and a moment, so there is no percentage to
 * show, only which of the two is happening.
 */
function busyLabel(creating: boolean): string {
  return creating ? 'Sending your code…' : 'Checking your passphrase…';
}

/** The bare host, so the footer reads as reassurance rather than a URL. */
function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}
