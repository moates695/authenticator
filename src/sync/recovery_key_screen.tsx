import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/theme/theme_context';
import { useAccount } from './account';

/**
 * Shown once, immediately after an account is created, and never again.
 *
 * The recovery key is the second wrapping of the data key. It is generated on
 * the device and the server only ever sees it wrapped, so this screen is the one
 * moment in the key's life when it can be read — hence the deliberate friction
 * of an explicit acknowledgement rather than a "Done" the user can tap past.
 */
export function RecoveryKeyScreen() {
  const { colors, spacing, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const { pendingRecoveryKey, acknowledgeRecoveryKey } = useAccount();

  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!pendingRecoveryKey) return null;

  const copy = async () => {
    await Clipboard.setStringAsync(pendingRecoveryKey);
    setCopied(true);
  };

  return (
    <View style={[StyleSheet.absoluteFillObject, styles.cover, { backgroundColor: colors.bg }]}>
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          padding: spacing.xl,
          paddingTop: insets.top + spacing.xl,
          paddingBottom: insets.bottom + spacing.xl,
          gap: spacing.lg,
        }}
      >
        <View style={{ alignItems: 'center', gap: spacing.sm }}>
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
            <Ionicons name="key-outline" size={30} color={colors.accent} />
          </View>
          <Text style={{ color: colors.text, fontSize: 20, fontWeight: '700' }}>
            Save your recovery key
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
            Write this down and keep it somewhere safe and offline. It is shown once and cannot be
            shown again — not by us, and not by the server, which only ever holds it encrypted.
          </Text>
        </View>

        <View
          style={{
            backgroundColor: colors.surface,
            borderColor: colors.border,
            borderWidth: StyleSheet.hairlineWidth,
            borderRadius: radius.md,
            padding: spacing.lg,
          }}
        >
          <Text
            selectable
            style={{
              color: colors.text,
              fontSize: 16,
              lineHeight: 26,
              letterSpacing: 1.5,
              textAlign: 'center',
              fontFamily: 'monospace',
            }}
          >
            {pendingRecoveryKey}
          </Text>
        </View>

        <Pressable
          onPress={() => void copy()}
          accessibilityRole="button"
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: spacing.sm,
            paddingVertical: spacing.sm,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Ionicons
            name={copied ? 'checkmark' : 'copy-outline'}
            size={16}
            color={copied ? colors.success : colors.accent}
          />
          <Text style={{ color: copied ? colors.success : colors.accent, fontSize: 14 }}>
            {copied ? 'Copied to clipboard' : 'Copy to clipboard'}
          </Text>
        </Pressable>

        <Text style={{ color: colors.textFaint, fontSize: 12, lineHeight: 18 }}>
          Signing in with a recovery key is not built yet, so today your passphrase is the only way
          back into your backup. The key is already part of the account, so saving it now means you
          are covered the moment that lands.
        </Text>

        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: spacing.md,
            backgroundColor: colors.surface,
            borderRadius: radius.md,
            paddingVertical: spacing.sm,
            paddingHorizontal: spacing.md,
          }}
        >
          <Text style={{ color: colors.text, fontSize: 15, flexShrink: 1 }}>
            I have written it down
          </Text>
          <Switch
            value={saved}
            onValueChange={setSaved}
            trackColor={{ true: colors.accent, false: colors.surfaceAlt }}
          />
        </View>

        <Pressable
          onPress={acknowledgeRecoveryKey}
          disabled={!saved}
          accessibilityRole="button"
          accessibilityState={{ disabled: !saved }}
          style={({ pressed }) => ({
            alignItems: 'center',
            backgroundColor: saved ? colors.accent : colors.surfaceAlt,
            borderRadius: radius.pill,
            paddingVertical: spacing.md,
            opacity: pressed && saved ? 0.75 : 1,
          })}
        >
          <Text
            style={{
              color: saved ? '#FFFFFF' : colors.textFaint,
              fontSize: 15,
              fontWeight: '600',
            }}
          >
            Continue
          </Text>
        </Pressable>
      </ScrollView>
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
