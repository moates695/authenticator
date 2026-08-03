import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Link, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CodeRow } from '@/components/CodeRow';
import { CountdownRing } from '@/components/CountdownRing';
import { useTheme } from '@/theme/theme_context';
import { entryTitle, type Entry } from '@/vault/types';
import { groupEntries, useVault } from '@/vault/vault_store';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

/** How long the add menu takes to open or close. */
const MENU_DURATION_MS = 160;

export default function HomeScreen() {
  const { colors, spacing, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { vault, loading, error, deleteEntry, advanceCounter } = useVault();

  const groups = useMemo(() => groupEntries(vault), [vault]);
  const isEmpty = vault.entries.length === 0;

  const [menuOpen, setMenuOpen] = useState(false);
  // Drives the backdrop fade, the menu rise, and the plus-to-cross rotation from
  // one value, so they cannot drift apart.
  const menuAnim = useRef(new Animated.Value(0)).current;

  const setMenu = useCallback(
    (open: boolean) => {
      setMenuOpen(open);
      Animated.timing(menuAnim, {
        toValue: open ? 1 : 0,
        duration: MENU_DURATION_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start();
    },
    [menuAnim],
  );

  const openAdd = useCallback(
    (mode: 'scan' | 'manual') => {
      setMenu(false);
      router.push({ pathname: '/add', params: { mode } });
    },
    [router, setMenu],
  );

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
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + spacing.sm,
            paddingHorizontal: spacing.lg,
            paddingBottom: spacing.md,
          },
        ]}
      >
        <View style={[styles.headerLeft, { gap: spacing.md }]}>
          <CountdownRing />
          <Text style={[styles.title, { color: colors.text }]}>Codes</Text>
        </View>
        <View style={[styles.headerActions, { gap: spacing.md }]}>
          <IconButton icon="folder-outline" label="Folders" href="/folders" />
          <IconButton icon="settings-outline" label="Settings" href="/settings" />
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

      {/*
        Dimmer behind the menu. It stays mounted so the fade plays on the way out
        as well as in, and only takes touches while the menu is actually open.
      */}
      <Animated.View
        style={[
          StyleSheet.absoluteFillObject,
          { backgroundColor: colors.overlay, opacity: menuAnim },
        ]}
        pointerEvents={menuOpen ? 'auto' : 'none'}
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => setMenu(false)}
          accessibilityRole="button"
          accessibilityLabel="Close add menu"
        />
      </Animated.View>

      <View
        style={[styles.fabCluster, { bottom: insets.bottom + spacing.lg, right: spacing.lg }]}
        pointerEvents="box-none"
      >
        <Animated.View
          style={[
            styles.menu,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
              borderRadius: radius.lg,
              marginBottom: spacing.sm,
              opacity: menuAnim,
              transform: [
                {
                  translateY: menuAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [10, 0],
                  }),
                },
              ],
            },
          ]}
          pointerEvents={menuOpen ? 'auto' : 'none'}
        >
          <MenuItem
            icon="qr-code-outline"
            label="Scan QR code"
            onPress={() => openAdd('scan')}
          />
          <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border }} />
          <MenuItem
            icon="create-outline"
            label="Enter manually"
            onPress={() => openAdd('manual')}
          />
        </Animated.View>

        <Pressable
          onPress={() => setMenu(!menuOpen)}
          style={({ pressed }) => [
            styles.fab,
            { backgroundColor: pressed ? colors.accentSoft : colors.accent },
          ]}
          accessibilityRole="button"
          accessibilityLabel={menuOpen ? 'Close add menu' : 'Add a code'}
          accessibilityState={{ expanded: menuOpen }}
        >
          <Animated.View
            style={{
              transform: [
                {
                  rotate: menuAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: ['0deg', '45deg'],
                  }),
                },
              ],
            }}
          >
            <Ionicons name="add" size={30} color="#FFFFFF" />
          </Animated.View>
        </Pressable>
      </View>
    </View>
  );
}

/** Header action. Icon-only, so the accessible name comes from the label. */
function IconButton({
  icon,
  label,
  href,
}: {
  icon: IoniconName;
  label: string;
  href: '/folders' | '/settings';
}) {
  const { colors } = useTheme();
  return (
    <Link href={href} asChild>
      <Pressable
        style={({ pressed }) => [
          styles.iconButton,
          {
            backgroundColor: pressed ? colors.surfaceAlt : colors.surface,
            borderColor: colors.border,
          },
        ]}
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        <Ionicons name={icon} size={19} color={colors.text} />
      </Pressable>
    </Link>
  );
}

function MenuItem({
  icon,
  label,
  onPress,
}: {
  icon: IoniconName;
  label: string;
  onPress: () => void;
}) {
  const { colors, spacing } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.menuItem,
        {
          backgroundColor: pressed ? colors.surfaceAlt : 'transparent',
          paddingVertical: spacing.md,
          paddingHorizontal: spacing.lg,
          gap: spacing.md,
        },
      ]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Ionicons name={icon} size={19} color={colors.accent} />
      <Text style={{ color: colors.text, fontSize: 15, fontWeight: '500' }}>{label}</Text>
    </Pressable>
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
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  headerActions: {
    flexDirection: 'row',
  },
  iconButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
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
  fabCluster: {
    position: 'absolute',
    alignItems: 'flex-end',
  },
  menu: {
    minWidth: 208,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  fab: {
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
});
