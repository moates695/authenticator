import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { countdownFor, useTick } from '@/otp/clock';
import { useTheme } from '@/theme/theme_context';
import { DEFAULT_PERIOD } from '@/vault/types';

const SIZE = 64;
const STROKE = 5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Seconds left below which the ring turns amber. */
const EXPIRING_AT = 5;

/**
 * The single shared countdown for the app, sized for the header. It tracks the
 * standard 30-second window; entries on a different cadence carry their own
 * indicator on their row instead.
 */
export function CountdownRing() {
  const { colors } = useTheme();
  const now = useTick();
  const { secondsRemaining, fractionRemaining } = countdownFor(now, DEFAULT_PERIOD);

  const expiring = secondsRemaining <= EXPIRING_AT;
  const sweep = colors[expiring ? 'expiring' : 'accent'];

  return (
    <View style={styles.container}>
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
        <Text style={[styles.seconds, { color: expiring ? colors.expiring : colors.text }]}>
          {secondsRemaining}
        </Text>
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
    fontSize: 20,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
});
