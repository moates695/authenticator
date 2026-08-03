import { useCallback, useMemo } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Link, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CodeRow } from '@/components/CodeRow';
import { CountdownRing } from '@/components/CountdownRing';
import { useTheme } from '@/theme/theme_context';
import { entryTitle, type Entry } from '@/vault/types';
import { groupEntries, useVault } from '@/vault/vault_store';

export default function HomeScreen() {
  const { colors, spacing, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { vault, loading, error, deleteEntry, advanceCounter } = useVault();

  const groups = useMemo(() => groupEntries(vault), [vault]);
  const isEmpty = vault.entries.length === 0;

  const confirmDelete = useCallback(
    (entry: Entry) => {
      Alert.alert(
        `Remove ${entryTitle(entry)}?`,
        'This deletes the code from this device. Make sure you can still sign in another way first.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: () => {
              void deleteEntry(entry.id).catch(() => {});
            },
          },
        ],
      );
    },
    [deleteEntry],
  );

  const handleAdvanceCounter = useCallback(
    (entry: Entry) => {
      void advanceCounter(entry.id).catch(() => {});
    },
    [advanceCounter],
  );

  return (
    <View style={[styles.screen, { backgroundColor: colors.bg }]}>
      <View style={[styles.header, { paddingHorizontal: spacing.lg, paddingBottom: spacing.md }]}>
        <CountdownRing />
        <View style={styles.headerActions}>
          <HeaderButton label="Folders" href="/folders" />
          <HeaderButton label="Settings" href="/settings" />
        </View>
      </View>

      {error ? (
        <View
          style={[
            styles.banner,
            {
              backgroundColor: colors.surface,
              borderColor: colors.danger,
              borderRadius: radius.md,
              marginHorizontal: spacing.lg,
              padding: spacing.md,
            },
          ]}
        >
          <Text style={{ color: colors.danger, fontSize: 13 }}>{error}</Text>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.centre}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : isEmpty ? (
        <EmptyState />
      ) : (
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: spacing.lg,
            paddingBottom: insets.bottom + 96,
            gap: spacing.xl,
          }}
        >
          {groups.map((group) => (
            <View key={group.folder?.id ?? 'unfiled'} style={{ gap: spacing.sm }}>
              <Text
                style={[
                  styles.groupHeading,
                  { color: colors.textMuted, paddingHorizontal: spacing.xs },
                ]}
              >
                {(group.folder?.name ?? 'Ungrouped').toUpperCase()}
              </Text>
              <View style={{ gap: spacing.sm }}>
                {group.entries.map((entry) => (
                  <CodeRow
                    key={entry.id}
                    entry={entry}
                    onLongPress={confirmDelete}
                    onAdvanceCounter={handleAdvanceCounter}
                  />
                ))}
              </View>
            </View>
          ))}
        </ScrollView>
      )}

      <Pressable
        onPress={() => router.push('/add')}
        style={({ pressed }) => [
          styles.fab,
          {
            backgroundColor: pressed ? colors.accentSoft : colors.accent,
            bottom: insets.bottom + spacing.lg,
            right: spacing.lg,
          },
        ]}
        accessibilityRole="button"
        accessibilityLabel="Add a code"
      >
        <Text style={styles.fabIcon}>+</Text>
      </Pressable>
    </View>
  );
}

function HeaderButton({ label, href }: { label: string; href: '/folders' | '/settings' }) {
  const { colors, spacing, radius } = useTheme();
  return (
    <Link href={href} asChild>
      <Pressable
        style={({ pressed }) => [
          {
            backgroundColor: pressed ? colors.surfaceAlt : colors.surface,
            borderRadius: radius.pill,
            paddingVertical: spacing.sm,
            paddingHorizontal: spacing.md,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.border,
          },
        ]}
      >
        <Text style={{ color: colors.text, fontSize: 13, fontWeight: '500' }}>{label}</Text>
      </Pressable>
    </Link>
  );
}

function EmptyState() {
  const { colors, spacing } = useTheme();
  return (
    <View style={[styles.centre, { paddingHorizontal: spacing.xl, gap: spacing.sm }]}>
      <Text style={[styles.emptyTitle, { color: colors.text }]}>No codes yet</Text>
      <Text style={[styles.emptyBody, { color: colors.textMuted }]}>
        Tap the plus button to scan a QR code or paste an otpauth:// link.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerActions: {
    flexDirection: 'row',
    gap: 8,
  },
  banner: {
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 12,
  },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  groupHeading: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  emptyBody: {
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  fab: {
    position: 'absolute',
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  fabIcon: {
    color: '#FFFFFF',
    fontSize: 30,
    lineHeight: 34,
    fontWeight: '300',
  },
});
