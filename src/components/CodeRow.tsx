import { memo, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';

import { countdownFor, useOtpWindow, useTick } from '@/otp/clock';
import { formatCode, generateCode, isOffCadence } from '@/otp/otp';
import { useTheme } from '@/theme/theme_context';
import { entrySubtitle, entryTitle, type Entry } from '@/vault/types';

type Props = {
  entry: Entry;
  onLongPress: (entry: Entry) => void;
  /** Bumps the HOTP counter; only wired up for counter-based entries. */
  onAdvanceCounter: (entry: Entry) => void;
};

/** How long the "Copied" confirmation stays up. */
const COPIED_FEEDBACK_MS = 1200;

function CodeRowInner({ entry, onLongPress, onAdvanceCounter }: Props) {
  const { colors, spacing, radius } = useTheme();
  const otpWindow = useOtpWindow();
  const [copied, setCopied] = useState(false);

  // Recomputed when the shared 30s window rolls, not on every clock tick.
  // Entries on a different period are handled by OffCadenceBadge below.
  const code = useMemo(() => {
    try {
      return generateCode(entry, Date.now());
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, otpWindow]);

  const copy = async () => {
    if (!code) return;
    await Clipboard.setStringAsync(code);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    if (entry.type === 'hotp') onAdvanceCounter(entry);
  };

  const subtitle = entrySubtitle(entry);

  return (
    <Pressable
      onPress={copy}
      onLongPress={() => onLongPress(entry)}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: pressed ? colors.surfaceAlt : colors.surface,
          borderRadius: radius.md,
          paddingVertical: spacing.md,
          paddingHorizontal: spacing.lg,
        },
      ]}
      accessibilityRole="button"
      accessibilityLabel={`${entryTitle(entry)}${subtitle ? `, ${subtitle}` : ''}. Tap to copy code.`}
    >
      <View style={styles.details}>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          {entryTitle(entry)}
        </Text>
        {subtitle ? (
          <Text style={[styles.subtitle, { color: colors.textMuted }]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>

      <View style={styles.codeArea}>
        {copied ? (
          <Text style={[styles.copied, { color: colors.success }]}>Copied</Text>
        ) : code ? (
          <Text style={[styles.code, { color: colors.text }]}>{formatCode(code)}</Text>
        ) : (
          <Text style={[styles.copied, { color: colors.danger }]}>Bad secret</Text>
        )}
        {isOffCadence(entry) ? <OffCadenceBadge entry={entry} /> : null}
      </View>
    </Pressable>
  );
}

/**
 * Entries that do not use the standard 30-second window cannot be described by
 * the header ring, so they show their own state: a per-entry countdown for an
 * unusual TOTP period, or a counter value for HOTP.
 */
function OffCadenceBadge({ entry }: { entry: Entry }) {
  const { colors } = useTheme();
  const now = useTick();

  if (entry.type === 'hotp') {
    return <Text style={[styles.badge, { color: colors.textFaint }]}>counter {entry.counter}</Text>;
  }

  const { secondsRemaining } = countdownFor(now, entry.period);
  return (
    <Text style={[styles.badge, { color: colors.textFaint }]}>
      {secondsRemaining}s · {entry.period}s cycle
    </Text>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  details: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
  },
  subtitle: {
    fontSize: 13,
    marginTop: 2,
  },
  codeArea: {
    alignItems: 'flex-end',
  },
  code: {
    fontSize: 24,
    fontWeight: '500',
    letterSpacing: 1.5,
    fontVariant: ['tabular-nums'],
  },
  copied: {
    fontSize: 15,
    fontWeight: '600',
  },
  badge: {
    fontSize: 11,
    marginTop: 2,
  },
});

/**
 * Rows are memoised because the shared clock re-renders the list frequently and
 * a row's output only depends on the entry plus the current OTP window.
 */
export const CodeRow = memo(CodeRowInner);
