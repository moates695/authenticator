import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { useAppLock } from '@/auth/lock';
import { ConfirmDialog } from '@/components/dialog';
import { useAccount } from '@/sync/account';
import { SYNC_BASE_URL } from '@/sync/api';
import { useTheme, type ThemePreference } from '@/theme/theme_context';
import { useVault } from '@/vault/vault_store';

export default function SettingsScreen() {
  const { colors, spacing, radius, preference, setPreference } = useTheme();
  const { vault } = useVault();
  const lock = useAppLock();
  const account = useAccount();

  const [signingOut, setSigningOut] = useState(false);

  // A device with nothing enrolled has no check to offer, and a build with the
  // testing override set ignores the preference either way. Both leave the row
  // showing why it cannot be changed rather than hiding it.
  const lockAvailable = !lock.disabledByBuild && lock.capability.method !== 'none';
  const lockHint = lock.disabledByBuild
    ? 'The app lock is switched off for this build by EXPO_PUBLIC_DISABLE_APP_LOCK. Clear that variable and rebuild to use it.'
    : lock.capability.method === 'none'
      ? 'This device has no screen lock set up, so there is nothing to check against. Add a fingerprint, PIN or pattern in your device settings.'
      : `Asks for ${lock.capability.label} when Authenticator opens, and again whenever it comes back from the background.`;

  const options: { value: ThemePreference; label: string }[] = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];

  return (
    <ScrollView
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: spacing.lg, gap: spacing.xl }}
    >
      <Section title="Appearance">
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          {options.map((option) => {
            const active = option.value === preference;
            return (
              <Pressable
                key={option.value}
                onPress={() => setPreference(option.value)}
                style={{
                  flex: 1,
                  alignItems: 'center',
                  paddingVertical: spacing.md,
                  borderRadius: radius.md,
                  backgroundColor: active ? colors.accent : colors.surface,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: active ? colors.accent : colors.border,
                }}
              >
                <Text
                  style={{
                    color: active ? '#FFFFFF' : colors.text,
                    fontSize: 14,
                    fontWeight: active ? '600' : '400',
                  }}
                >
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Section>

      <Section title="Security">
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            backgroundColor: colors.surface,
            borderRadius: radius.md,
            paddingVertical: spacing.sm,
            paddingHorizontal: spacing.md,
            opacity: lockAvailable ? 1 : 0.5,
          }}
        >
          <Text style={{ color: colors.text, fontSize: 15, flexShrink: 1 }}>
            Require {lock.capability.label} to open
          </Text>
          <Switch
            value={lockAvailable && lock.enabled}
            // Resolves false when the check needed to turn the lock off was not
            // passed; the switch is driven by the stored value, so it springs
            // back on its own.
            onValueChange={(next) => void lock.setEnabled(next)}
            disabled={!lockAvailable}
            trackColor={{ true: colors.accent, false: colors.surfaceAlt }}
          />
        </View>
        {lock.error ? (
          <Text style={{ color: colors.danger, fontSize: 12, lineHeight: 18 }}>{lock.error}</Text>
        ) : null}
        <Text style={{ color: colors.textFaint, fontSize: 12, lineHeight: 18 }}>{lockHint}</Text>
      </Section>

      <Section title="Account">
        <Row label="Signed in as" value={account.account?.email ?? '—'} />
        <Row label="Backup server" value={hostOf(SYNC_BASE_URL)} />
        <Pressable
          onPress={() => setSigningOut(true)}
          style={({ pressed }) => ({
            alignItems: 'center',
            paddingVertical: spacing.md,
            borderRadius: radius.md,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.border,
            backgroundColor: pressed ? colors.surfaceAlt : 'transparent',
          })}
          accessibilityRole="button"
        >
          <Text style={{ color: colors.danger, fontSize: 15, fontWeight: '600' }}>Sign out</Text>
        </Pressable>
        <Text style={{ color: colors.textFaint, fontSize: 12, lineHeight: 18 }}>
          Your passphrase never leaves this device, and neither does the key it unwraps. The server
          holds your codes only as ciphertext it has no way to open.
          {'\n\n'}
          {lockAvailable
            ? `Opening Authenticator with ${lock.capability.label} keeps you signed in. `
            : 'Opening Authenticator keeps you signed in. '}
          Leave it unopened for a couple of weeks and your passphrase and an emailed code are needed
          again.
        </Text>
      </Section>

      <Section title="Vault">
        <Row label="Codes" value={String(vault.entries.length)} />
        <Row label="Folders" value={String(vault.folders.length)} />
        <Row label="Stored" value="Encrypted here and backed up" />
        <Text style={{ color: colors.textFaint, fontSize: 12, lineHeight: 18, marginTop: spacing.sm }}>
          Your codes are encrypted with a key held in this device's secure keystore. The same key is
          stored on the server wrapped under your passphrase, which is what lets a new device get
          them back.
        </Text>
      </Section>

      <Section title="Not built yet">
        <Text style={{ color: colors.textMuted, fontSize: 13, lineHeight: 20 }}>
          Continuous sync, signing in with a recovery key, import from other authenticator apps and
          export are the next things to land. Your backup is written when you sign in, so changes
          since then only exist on this device.
        </Text>
      </Section>

      <ConfirmDialog
        visible={signingOut}
        title="Sign out?"
        message={
          'Your codes stay encrypted on this device, and your backup stays on the server. You will need your passphrase to get back in.'
        }
        confirmLabel="Sign out"
        destructive
        onCancel={() => setSigningOut(false)}
        onConfirm={() => {
          setSigningOut(false);
          void account.signOut();
        }}
      />
    </ScrollView>
  );
}

/** The bare host, so the row reads as a place rather than a URL. */
function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const { colors, spacing } = useTheme();
  return (
    <View style={{ gap: spacing.sm }}>
      <Text
        style={{ color: colors.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.8 }}
      >
        {title.toUpperCase()}
      </Text>
      {children}
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  const { colors, spacing, radius } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        backgroundColor: colors.surface,
        borderRadius: radius.md,
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.md,
      }}
    >
      <Text style={{ color: colors.text, fontSize: 15 }}>{label}</Text>
      <Text style={{ color: colors.textMuted, fontSize: 14 }}>{value}</Text>
    </View>
  );
}
