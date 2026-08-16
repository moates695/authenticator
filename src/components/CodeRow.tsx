import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  interpolateColor,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { countdownFor, useTick, useWindowIndex } from '@/otp/clock';
import { formatCode, generateCode, isOffCadence } from '@/otp/otp';
import { useTheme } from '@/theme/theme_context';
import { entrySubtitle, entryTitle, type Entry } from '@/vault/types';

type Props = {
  entry: Entry;
  /** True when this is the row whose settings action is showing. */
  open: boolean;
  /** Asks the list to open this row's action, or to put it away. */
  onOpenChange: (entry: Entry, open: boolean) => void;
  onOpenSettings: (entry: Entry) => void;
  /** Bumps the HOTP counter; only wired up for counter-based entries. */
  onAdvanceCounter: (entry: Entry) => void;
};

/** How long the "Copied" confirmation stays up. */
const COPIED_FEEDBACK_MS = 1200;

/** Width of the settings action hiding behind the row. */
const ACTION_WIDTH = 92;
/** Drag past this and the release opens settings directly, without a second tap. */
const FULL_SWIPE_AT = ACTION_WIDTH * 1.9;
/** Release short of this and the row springs shut again. */
const SNAP_AT = ACTION_WIDTH * 0.5;
/** A little travel past the full-swipe point, so the gesture never feels walled off. */
const MAX_DRAG = FULL_SWIPE_AT + 28;

const SETTLE_MS = 180;
const PRESS_IN_MS = 90;
const PRESS_OUT_MS = 160;

/** Flick velocity counts towards the decision, so a fast short swipe still opens. */
const VELOCITY_WEIGHT = 0.05;

function CodeRowInner({ entry, open, onOpenChange, onOpenSettings, onAdvanceCounter }: Props) {
  const { colors, spacing, radius } = useTheme();
  const [copied, setCopied] = useState(false);

  /** Rolls when this entry's own code does, whatever period it is on. */
  const codeWindow = useWindowIndex(entry.period);

  // Recomputed when this entry's window rolls, not on every clock tick.
  const code = useMemo(() => {
    try {
      return generateCode(entry, Date.now());
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, codeWindow]);

  /** Held so a fresh copy, or a rolled window, can cancel the pending reset. */
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCopied = useCallback(() => {
    if (copiedTimer.current) {
      clearTimeout(copiedTimer.current);
      copiedTimer.current = null;
    }
    setCopied(false);
  }, []);

  // Once this entry's window rolls, the code on screen is no longer the one on
  // the clipboard, so the confirmation must not outlive it. Running as cleanup
  // ties it to the window it was shown for, and clears the timer on unmount too.
  // An HOTP code does not roll with any clock, so it is pinned to a constant
  // here and retired by its own timer alone.
  const copiedWindow = entry.type === 'hotp' ? 0 : codeWindow;
  useEffect(() => clearCopied, [copiedWindow, clearCopied]);

  const translateX = useSharedValue(0);
  /** Where the row sat when the current drag began. */
  const startX = useSharedValue(0);
  /** 0 to 1 press-in tint, replacing what Pressable used to give us for free. */
  const pressed = useSharedValue(0);

  // The list owns which row is open, so a row also has to follow that state when
  // it changes for reasons other than its own gesture — such as another row
  // being swiped, which must put this one away.
  useEffect(() => {
    translateX.value = withTiming(open ? -ACTION_WIDTH : 0, { duration: SETTLE_MS });
  }, [open, translateX]);

  const requestOpen = useCallback(
    (next: boolean) => onOpenChange(entry, next),
    [entry, onOpenChange],
  );

  const openSettings = useCallback(() => {
    onOpenChange(entry, false);
    onOpenSettings(entry);
  }, [entry, onOpenChange, onOpenSettings]);

  const copy = useCallback(async () => {
    if (!code) return;
    await Clipboard.setStringAsync(code);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    if (entry.type === 'hotp') onAdvanceCounter(entry);
  }, [code, entry, onAdvanceCounter]);

  /** A tap on an already-open row puts it away rather than copying by surprise. */
  const handleTap = useCallback(() => {
    if (open) {
      requestOpen(false);
      return;
    }
    void copy();
  }, [open, requestOpen, copy]);

  const handleLongPress = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    openSettings();
  }, [openSettings]);

  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      // Only a decisive horizontal drag takes the touch; everything else is left
      // to the list, so vertical scrolling still works over the top of a row.
      .activeOffsetX([-14, 14])
      .failOffsetY([-12, 12])
      .onStart(() => {
        startX.value = translateX.value;
      })
      .onUpdate((e) => {
        // Leftwards only: there is nothing to reveal on the other side.
        translateX.value = Math.min(0, Math.max(startX.value + e.translationX, -MAX_DRAG));
      })
      .onEnd((e) => {
        const projected = translateX.value + e.velocityX * VELOCITY_WEIGHT;

        if (projected < -FULL_SWIPE_AT) {
          translateX.value = withTiming(0, { duration: SETTLE_MS });
          runOnJS(openSettings)();
          return;
        }

        const shouldOpen = projected < -SNAP_AT;
        translateX.value = withTiming(shouldOpen ? -ACTION_WIDTH : 0, { duration: SETTLE_MS });
        runOnJS(requestOpen)(shouldOpen);
      });

    const longPress = Gesture.LongPress()
      .minDuration(450)
      .onStart(() => {
        runOnJS(handleLongPress)();
      });

    const tap = Gesture.Tap()
      .onBegin(() => {
        pressed.value = withTiming(1, { duration: PRESS_IN_MS });
      })
      .onFinalize(() => {
        pressed.value = withTiming(0, { duration: PRESS_OUT_MS });
      })
      .onEnd((_e, success) => {
        if (success) runOnJS(handleTap)();
      });

    // Whichever recognises first wins: movement is a swipe, a hold is a long
    // press, and a quick release is a tap.
    return Gesture.Race(pan, longPress, tap);
  }, [handleTap, handleLongPress, openSettings, requestOpen, pressed, startX, translateX]);

  const faceStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
    backgroundColor: interpolateColor(pressed.value, [0, 1], [colors.surface, colors.surfaceAlt]),
  }));

  /**
   * The tray grows with the drag so a long swipe never exposes a blank gap
   * beside a fixed-width action, and warms to the accent tint as it crosses the
   * point where letting go opens settings — the only cue that a full swipe does
   * anything at all.
   */
  const trayStyle = useAnimatedStyle(() => {
    const dragged = -translateX.value;
    return {
      width: Math.max(ACTION_WIDTH, dragged),
      backgroundColor: interpolateColor(
        dragged,
        [FULL_SWIPE_AT - 28, FULL_SWIPE_AT],
        [colors.surfaceAlt, colors.accentSoft],
      ),
    };
  });

  // The action fades and grows in as it is uncovered, rather than sitting there
  // fully formed behind a row that has not moved yet.
  const actionStyle = useAnimatedStyle(() => {
    const progress = Math.min(1, -translateX.value / ACTION_WIDTH);
    return { opacity: progress, transform: [{ scale: 0.85 + progress * 0.15 }] };
  });

  const title = entryTitle(entry);
  const subtitle = entrySubtitle(entry);

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.surfaceAlt, borderRadius: radius.md },
      ]}
    >
      <Animated.View style={[styles.actionLayer, trayStyle]}>
        <Animated.View style={actionStyle}>
          <Pressable
            onPress={openSettings}
            hitSlop={6}
            style={{ alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.sm }}
            accessibilityRole="button"
            accessibilityLabel={`Settings for ${title}`}
            // Announcing a button hidden under an unswiped row would be noise;
            // the row itself carries an equivalent accessibility action.
            accessibilityElementsHidden={!open}
            importantForAccessibility={open ? 'yes' : 'no-hide-descendants'}
          >
            <Ionicons name="options-outline" size={20} color={colors.accent} />
            <Text style={{ color: colors.accent, fontSize: 12, fontWeight: '600' }}>Settings</Text>
          </Pressable>
        </Animated.View>
      </Animated.View>

      <GestureDetector gesture={gesture}>
        <Animated.View
          style={[
            styles.face,
            {
              borderRadius: radius.md,
              paddingVertical: spacing.md,
              paddingHorizontal: spacing.lg,
            },
            faceStyle,
          ]}
          accessible
          accessibilityRole="button"
          accessibilityLabel={`${title}${subtitle ? `, ${subtitle}` : ''}. Tap to copy code.`}
          // Swiping is not reachable under a screen reader, so settings gets an
          // explicit action in the rotor / actions menu instead.
          accessibilityActions={[{ name: 'longpress', label: 'Open code settings' }]}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === 'longpress') openSettings();
          }}
        >
          <View style={styles.details}>
            <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
              {title}
            </Text>
            {subtitle ? (
              <Text style={[styles.subtitle, { color: colors.textMuted }]} numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </View>

          <View style={styles.codeArea}>
            {code ? (
              <Text style={[styles.code, { color: copied ? colors.success : colors.text }]}>
                {formatCode(code)}
              </Text>
            ) : (
              <Text style={[styles.status, { color: colors.danger }]}>Bad secret</Text>
            )}
            {/* Always rendered so the confirmation cannot push the row's height
                around while the list is being read. */}
            <View style={styles.statusLine}>
              {copied ? (
                <Text style={[styles.status, { color: colors.success }]}>Copied</Text>
              ) : isOffCadence(entry) ? (
                <OffCadenceBadge entry={entry} />
              ) : null}
            </View>
          </View>
        </Animated.View>
      </GestureDetector>
    </View>
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
  container: {
    // Clips the action strip and keeps the sliding face inside the rounded
    // corners on the way out.
    overflow: 'hidden',
  },
  actionLayer: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  face: {
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
  statusLine: {
    height: 14,
    justifyContent: 'center',
    marginTop: 2,
  },
  status: {
    fontSize: 12,
    fontWeight: '600',
  },
  badge: {
    fontSize: 11,
  },
});

/**
 * Rows are memoised because the shared clock re-renders the list frequently and
 * a row's output only depends on the entry, the current OTP window, and whether
 * this particular row is the open one.
 */
export const CodeRow = memo(CodeRowInner);
