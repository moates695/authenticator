import { useCallback, useEffect } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedProps,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';

import { countdownFor, useOtpWindow, useTick } from '@/otp/clock';
import type { Palette } from '@/theme/palette';
import { useTheme } from '@/theme/theme_context';
import { DEFAULT_PERIOD } from '@/vault/types';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

const SIZE = 34;
const STROKE = 3;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Urgency bands, in seconds remaining. secondsRemaining is a ceiling, so a
 * displayed "3" means the true remaining time is already under three seconds:
 * comparing with <= gives exactly three red ticks and seven orange ones.
 */
const RED_AT = 3;
const ORANGE_AT = 10;

/**
 * Ring colour plus the colour for the number inside it. The number stays neutral
 * while there is plenty of time left, and picks up the urgency colour after that.
 */
function bandColours(secondsRemaining: number, colors: Palette) {
  if (secondsRemaining <= RED_AT) return { sweep: colors.danger, label: colors.danger };
  if (secondsRemaining <= ORANGE_AT) return { sweep: colors.expiring, label: colors.expiring };
  return { sweep: colors.accent, label: colors.text };
}

/**
 * The single shared countdown for the app: a small ring with the seconds
 * remaining inside it, sized to sit inline in the header. It tracks the standard
 * 30-second window; entries on a different cadence carry their own indicator on
 * their row instead.
 *
 * The number comes from the shared clock, which ticks a few times a second. The
 * sweep cannot: at that rate it would visibly step round the circle. Instead it
 * runs as a single linear animation on the UI thread, re-anchored to the wall
 * clock whenever the window rolls, so it stays both smooth and honest.
 */
export function CountdownRing() {
  const { colors } = useTheme();
  const now = useTick();
  const otpWindow = useOtpWindow();
  const { secondsRemaining } = countdownFor(now, DEFAULT_PERIOD);

  const { sweep, label } = bandColours(secondsRemaining, colors);

  /** How far through the window the sweep is: 0 at the start, 1 at the end. */
  const elapsed = useSharedValue(0);

  const sync = useCallback(() => {
    const { fractionRemaining } = countdownFor(Date.now(), DEFAULT_PERIOD);
    cancelAnimation(elapsed);
    // Jump to where the wall clock actually is, then run out the rest of the
    // window at a constant rate.
    elapsed.value = 1 - fractionRemaining;
    elapsed.value = withTiming(1, {
      duration: fractionRemaining * DEFAULT_PERIOD * 1000,
      easing: Easing.linear,
    });
  }, [elapsed]);

  useEffect(() => {
    sync();
  }, [sync, otpWindow]);

  useEffect(() => {
    // Backgrounded apps get no frames, so the animation is behind on resume.
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') sync();
    });
    return () => subscription.remove();
  }, [sync]);

  useEffect(() => {
    return () => cancelAnimation(elapsed);
  }, [elapsed]);

  const animatedProps = useAnimatedProps(() => ({
    strokeDashoffset: CIRCUMFERENCE * elapsed.value,
  }));

  return (
    <View
      style={styles.container}
      accessibilityRole="timer"
      accessibilityLabel={`${secondsRemaining} seconds until codes refresh`}
    >
      <Svg width={SIZE} height={SIZE}>
        <Circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          stroke={colors.surfaceAlt}
          strokeWidth={STROKE}
          fill="none"
        />
        <AnimatedCircle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          stroke={sweep}
          strokeWidth={STROKE}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          animatedProps={animatedProps}
          // Start the sweep at 12 o'clock rather than 3 o'clock.
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      </Svg>
      <View style={styles.label} pointerEvents="none">
        <Text style={[styles.seconds, { color: label }]}>{secondsRemaining}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: SIZE,
    height: SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  seconds: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
});
