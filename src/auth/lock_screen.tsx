import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '@/theme/theme_context';
import { useAppLock } from './lock';
import { isForeground } from './lock_policy';

/**
 * The cover that sits over the app while it is locked.
 *
 * It is an overlay rather than a replacement for the navigator so that a lock
 * does not throw away where the user was: coming back from the background lands
 * them on the screen they left, half-typed add form and all.
 */
export function LockScreen() {
  const { colors, spacing, radius } = useTheme();
  const { state, capability, error, unlock } = useAppLock();

  const [busy, setBusy] = useState(false);

  const attemptUnlock = useCallback(async () => {
    setBusy(true);
    try {
      await unlock();
    } finally {
      setBusy(false);
    }
  }, [unlock]);

  // Raising the prompt while the app is in the background would put it in front
  // of whatever the user actually switched to.
  const [foreground, setForeground] = useState(() => isForeground(AppState.currentState));
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) =>
      setForeground(isForeground(next)),
    );
    return () => subscription.remove();
  }, []);

  /**
   * The prompt comes up on its own once per lock. After that the button drives
   * it: a user who cancelled is telling us they do not want to unlock yet, and
   * re-raising the prompt on every stray foreground event would trap them in it.
   */
  const prompted = useRef(false);
  useEffect(() => {
    if (state !== 'locked' || !foreground || prompted.current) return;
    prompted.current = true;
    void attemptUnlock();
  }, [state, foreground, attemptUnlock]);

  return (
    <View
      style={[StyleSheet.absoluteFillObject, styles.cover, { backgroundColor: colors.bg }]}
      // The screens underneath are still mounted. Claiming the responder makes
      // this swallow every touch aimed at them, including the ones that land on
      // empty parts of the cover where there is nothing of ours to press.
      pointerEvents="auto"
      onStartShouldSetResponder={() => true}
      accessibilityViewIsModal
    >
      {/* Nothing is drawn until the check is done, so a launch straight into an
          unlocked app does not flash a lock screen on the way past. */}
      {state === 'checking' ? null : (
        <View style={[styles.content, { padding: spacing.xl, gap: spacing.lg }]}>
          <View
            style={[
              styles.badge,
              { backgroundColor: colors.accentSoft, marginBottom: spacing.sm },
            ]}
          >
            <Ionicons name="lock-closed" size={30} color={colors.accent} />
          </View>

          <Text style={[styles.title, { color: colors.text }]}>Authenticator is locked</Text>
          <Text style={[styles.body, { color: colors.textMuted }]}>
            Your codes are hidden until you unlock with {capability.label}.
          </Text>

          {error ? (
            <Text style={[styles.body, { color: colors.danger }]}>{error}</Text>
          ) : null}

          <Pressable
            onPress={() => void attemptUnlock()}
            disabled={busy}
            style={({ pressed }) => [
              styles.button,
              {
                backgroundColor: colors.accent,
                borderRadius: radius.pill,
                paddingVertical: spacing.md,
                paddingHorizontal: spacing.xl,
                marginTop: spacing.sm,
                opacity: pressed || busy ? 0.75 : 1,
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel={`Unlock with ${capability.label}`}
          >
            <Text style={styles.buttonLabel}>Unlock with {capability.label}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  cover: {
    // Android draws by elevation rather than child order, so the cover needs
    // both to stay reliably on top of the navigator.
    zIndex: 10,
    elevation: 24,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    maxWidth: 300,
  },
  button: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLabel: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
});
