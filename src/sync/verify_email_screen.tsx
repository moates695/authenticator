import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConfirmDialog } from '@/components/dialog';
import { CodeInput } from '@/components/form';
import { KeyboardAwareScrollView } from '@/components/keyboard';
import { useTheme } from '@/theme/theme_context';
import { useAccount } from './account';
import {
  VERIFICATION_CODE_LENGTH,
  formatCountdown,
  isCompleteCode,
  secondsRemaining,
} from './account_policy';

/** How long before another code may be asked for. The server caps the total. */
const RESEND_COOLDOWN_MS = 30_000;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * A once-a-second tick, local to whichever leaf needs it.
 *
 * The shared clock in `@/otp/clock` runs five times a second for the countdown
 * rings, and re-rendering a controlled text field at that rate to move a colon
 * is a poor trade.
 */
function useSecondTick(): number {
  const [now, setNow] = useState(nowSeconds);
  useEffect(() => {
    const timer = setInterval(() => setNow(nowSeconds()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * Invisible rather than gone. Once the code is submitted the countdown and the
 * resend offer are spent words, but unmounting them would collapse this
 * column's gaps and shove everything else around — and they have to come back,
 * in place, if the code turns out to be wrong.
 */
function HidesInPlace({ hidden, children }: { hidden: boolean; children: ReactNode }) {
  return (
    <View
      style={{ opacity: hidden ? 0 : 1 }}
      pointerEvents={hidden ? 'none' : 'auto'}
      accessibilityElementsHidden={hidden}
      importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
    >
      {children}
    </View>
  );
}

/** How long the code in the inbox has left, or that it has none. */
function ExpiryLine({ deadline }: { deadline: number }) {
  const { colors } = useTheme();
  const left = secondsRemaining(deadline, useSecondTick());

  return (
    <Text style={{ color: left > 0 ? colors.textFaint : colors.danger, fontSize: 12 }}>
      {left > 0
        ? `This code expires in ${formatCountdown(left)}.`
        : 'This code has expired. Send another one.'}
    </Text>
  );
}

function ResendButton({
  readyAt,
  disabled,
  onPress,
}: {
  /** Epoch ms before which the button stays quiet, to stop a nervous tap storm. */
  readyAt: number;
  disabled: boolean;
  onPress: () => void;
}) {
  const { colors, spacing } = useTheme();
  useSecondTick();

  const waiting = Math.ceil((readyAt - Date.now()) / 1000);
  const held = waiting > 0 || disabled;

  return (
    <Pressable
      onPress={onPress}
      disabled={held}
      accessibilityRole="button"
      accessibilityState={{ disabled: held }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.sm,
        paddingVertical: spacing.sm,
        opacity: pressed && !held ? 0.6 : 1,
      })}
    >
      <Ionicons name="refresh" size={15} color={held ? colors.textFaint : colors.accent} />
      <Text style={{ color: held ? colors.textFaint : colors.accent, fontSize: 14 }}>
        {waiting > 0 ? `Send another code in ${waiting}s` : 'Send another code'}
      </Text>
    </Pressable>
  );
}

/**
 * The second factor, and the only way past the account gate.
 *
 * For a sign-in, the passphrase has already been proved by the time this is on
 * screen — that is what the code being here at all says — and the key that opens
 * the vault is derived once the six digits are accepted, which is the wait the
 * button explains. For a new account nothing exists anywhere yet: asking for the
 * code needed only the address, and the passphrase is being stretched into keys
 * in the background while the user is off reading their inbox.
 *
 * Either way nothing is worth anything yet: no session has been issued, no data
 * key has been installed on this device, and the account cannot be used by
 * anyone — including whoever typed the passphrase — until the code comes back.
 */
export function VerifyEmailScreen() {
  const { colors, spacing, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const account = useAccount();
  const pending = account.pendingVerification;

  const [code, setCode] = useState('');
  /** Epoch ms. Moved forward every time a code goes out. */
  const [resendReadyAt, setResendReadyAt] = useState(() => Date.now() + RESEND_COOLDOWN_MS);
  /** How many codes signing in would overwrite, while the user decides. */
  const [replacing, setReplacing] = useState<number | null>(null);

  if (!pending) return null;

  const registering = pending.purpose === 'register';

  const submit = async (value: string) => {
    if (account.busy || !isCompleteCode(value)) return;

    const outcome = await account.submitCode(value);
    if (outcome.ok) return;

    // Wrong, expired, or spent — whichever it was, the digits on screen are of
    // no further use and leaving them there invites a second tap on the same
    // failure.
    setCode('');
    if (!outcome.ok && outcome.reason === 'would_replace_local') {
      setReplacing(outcome.localCodes);
    }
  };

  const resend = async () => {
    setCode('');
    if (await account.resendCode()) setResendReadyAt(Date.now() + RESEND_COOLDOWN_MS);
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
            <Ionicons name="mail-unread-outline" size={30} color={colors.accent} />
          </View>
          <Text style={{ color: colors.text, fontSize: 20, fontWeight: '700' }}>
            Check your email
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
            We sent a {VERIFICATION_CODE_LENGTH} digit code to{' '}
            <Text style={{ color: colors.text, fontWeight: '600' }}>{pending.email}</Text>. It
            works once, and only for a few minutes.
          </Text>
        </View>

        <CodeInput
          value={code}
          onChangeText={setCode}
          length={VERIFICATION_CODE_LENGTH}
          editable={!account.busy}
          autoFocus
          onComplete={(value) => void submit(value)}
        />

        <HidesInPlace hidden={account.busy}>
          <ExpiryLine deadline={pending.codeExpiresAt} />
        </HidesInPlace>

        {registering ? (
          // One steady line for the whole stay on this screen, so finishing the
          // derivation does not move the code field mid-typing.
          <HidesInPlace hidden={account.busy}>
            {/* minHeight holds two lines, so the longer message wrapping on a
                narrow screen and the shorter one replacing it occupy the same
                space. */}
            <Text style={{ color: colors.textFaint, fontSize: 12, lineHeight: 18, minHeight: 36 }}>
              {account.progress !== null
                ? `Preparing your encryption key in the background… ${Math.round(account.progress * 100)}%. No need to wait for it.`
                : 'Your encryption key is ready.'}
            </Text>
          </HidesInPlace>
        ) : null}

        {account.error ? (
          <Text style={{ color: colors.danger, fontSize: 13, lineHeight: 19 }}>
            {account.error}
          </Text>
        ) : null}

        <Pressable
          onPress={() => void submit(code)}
          disabled={account.busy || !isCompleteCode(code)}
          accessibilityRole="button"
          accessibilityState={{ disabled: account.busy || !isCompleteCode(code) }}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: spacing.sm,
            backgroundColor: isCompleteCode(code) ? colors.accent : colors.surfaceAlt,
            borderRadius: radius.pill,
            paddingVertical: spacing.md,
            opacity: pressed || account.busy ? 0.75 : 1,
          })}
        >
          {account.busy ? <ActivityIndicator size="small" color="#FFFFFF" /> : null}
          <Text
            style={{
              color: isCompleteCode(code) ? '#FFFFFF' : colors.textFaint,
              fontSize: 15,
              fontWeight: '600',
            }}
          >
            {account.busy
              ? // Nothing says "key" until the code has been accepted. The
                // derivation may well be running behind this — a registration's
                // started when the code was sent — but showing it while the six
                // digits are still in question reads as though they passed.
                account.stage === 'checking'
                ? 'Checking your code…'
                : account.progress !== null
                  ? // Signing in, this is the derivation itself, which starts
                    // the moment the code is accepted. Registering, it is
                    // whatever the code beat back from the inbox.
                    `Deriving your key… ${Math.round(account.progress * 100)}%`
                  : registering
                    ? 'Creating your account…'
                    : 'Signing you in…'
              : registering
                ? 'Confirm and create account'
                : 'Confirm and sign in'}
          </Text>
        </Pressable>

        <HidesInPlace hidden={account.busy}>
          <ResendButton readyAt={resendReadyAt} disabled={account.busy} onPress={() => void resend()} />
        </HidesInPlace>

        <Pressable
          onPress={account.cancelVerification}
          disabled={account.busy}
          accessibilityRole="button"
          style={({ pressed }) => ({
            alignItems: 'center',
            paddingVertical: spacing.sm,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>
            Use a different email address
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
          {registering
            ? 'Confirming the address is what creates the account. Until then it cannot be used, and nothing is stored on this device.'
            : 'Your passphrase alone does not open the backup. This code is the second half.'}
        </Text>
      </KeyboardAwareScrollView>

      <ConfirmDialog
        visible={replacing !== null}
        title="Replace the codes on this device?"
        message={
          `This device has ${replacing} ${replacing === 1 ? 'code' : 'codes'} that are not in this account. ` +
          'Signing in restores the account’s backup over the top of them, and they cannot be brought back.'
        }
        confirmLabel="Replace"
        destructive
        onCancel={() => {
          setReplacing(null);
          account.cancelVerification();
        }}
        onConfirm={() => {
          setReplacing(null);
          void account.confirmReplaceLocal();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  cover: {
    // Same layering rule as the sign-in gate: Android needs the elevation too.
    zIndex: 5,
    elevation: 16,
  },
});
