import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useTheme, type ThemePreference } from '@/theme/theme_context';
import { useVault } from '@/vault/vault_store';

export default function SettingsScreen() {
  const { colors, spacing, radius, preference, setPreference } = useTheme();
  const { vault } = useVault();

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

      <Section title="Vault">
        <Row label="Codes" value={String(vault.entries.length)} />
        <Row label="Folders" value={String(vault.folders.length)} />
        <Row label="Stored" value="Encrypted on this device" />
        <Text style={{ color: colors.textFaint, fontSize: 12, lineHeight: 18, marginTop: spacing.sm }}>
          Your codes are encrypted with a key held in this device's secure keystore. The key never
          leaves the device.
        </Text>
      </Section>

      <Section title="Not built yet">
        <Text style={{ color: colors.textMuted, fontSize: 13, lineHeight: 20 }}>
          Encrypted backup and sync, import from other authenticator apps, and export are the next
          things to land. Until backup exists, treat this device as the only copy of your codes and
          keep the recovery options your accounts gave you.
        </Text>
      </Section>
    </ScrollView>
  );
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
