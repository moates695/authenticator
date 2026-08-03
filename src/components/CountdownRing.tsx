import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { countdownFor, useTick } from '@/otp/clock';
import type { Palette } from '@/theme/palette';
import { useTheme } from '@/theme/theme_context';
import { DEFAULT_PERIOD } from '@/vault/types';

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
 */
export function CountdownRing() {
  const { colors } = useTheme();
  const now = useTick();
  const { secondsRemaining, fractionRemaining } = countdownFor(now, DEFAULT_PERIOD);

  const { sweep, label } = bandColours(secondsRemaining, colors);

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
        <Circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          stroke={sweep}
          strokeWidth={STROKE}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - fractionRemaining)}
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
