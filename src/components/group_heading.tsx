import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { useTheme } from '@/theme/theme_context';

/** How long the chevron takes to swing between open and closed. */
const CHEVRON_DURATION_MS = 160;

/** Pointing down means open; a quarter turn anticlockwise points it at the name. */
const COLLAPSED_ROTATION = -90;

type Props = {
  title: string;
  /** How many codes are inside. */
  count: number;
  collapsed: boolean;
  onToggle: () => void;
};

/**
 * The tappable heading above each folder on the home screen. It is the only
 * control for collapsing a folder, so the chevron is always visible rather than
 * appearing on hover or press.
 */
export function GroupHeading({ title, count, collapsed, onToggle }: Props) {
  const { colors, spacing, radius } = useTheme();

  const rotation = useSharedValue(collapsed ? COLLAPSED_ROTATION : 0);

  useEffect(() => {
    rotation.value = withTiming(collapsed ? COLLAPSED_ROTATION : 0, {
      duration: CHEVRON_DURATION_MS,
    });
  }, [collapsed, rotation]);

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  return (
    <Pressable
      onPress={onToggle}
      style={({ pressed }) => [
        styles.row,
        {
          gap: spacing.xs,
          paddingHorizontal: spacing.xs,
          paddingVertical: spacing.sm,
          borderRadius: radius.sm,
          backgroundColor: pressed ? colors.surface : 'transparent',
        },
      ]}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${count} code${count === 1 ? '' : 's'}`}
      accessibilityHint={collapsed ? 'Shows the codes inside' : 'Hides the codes inside'}
      accessibilityState={{ expanded: !collapsed }}
    >
      <Animated.View style={chevronStyle}>
        <Ionicons name="chevron-down" size={13} color={colors.textMuted} />
      </Animated.View>

      <Text style={[styles.title, { color: colors.textMuted }]} numberOfLines={1}>
        {title.toUpperCase()}
      </Text>

      <View
        style={[
          styles.count,
          {
            backgroundColor: colors.surface,
            borderRadius: radius.sm,
            paddingHorizontal: spacing.sm,
          },
        ]}
      >
        <Text style={[styles.countText, { color: colors.textFaint }]}>{count}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    // Spans the full width so the whole line toggles the folder, not just the
    // name itself.
    alignSelf: 'stretch',
    // Keeps the tap target comfortable even though the label itself is small.
    minHeight: 40,
  },
  title: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    flexShrink: 1,
  },
  count: {
    minWidth: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 'auto',
  },
  countText: {
    fontSize: 11,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
});
