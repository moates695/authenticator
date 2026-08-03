import { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider as NavigationThemeProvider,
  type Theme,
} from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ClockProvider } from '@/otp/clock';
import { ThemeProvider, useTheme } from '@/theme/theme_context';
import { VaultProvider } from '@/vault/vault_store';

/**
 * Lives inside ThemeProvider so navigation chrome picks up the same palette as
 * the screens, in both light and dark mode.
 *
 * There are four separate layers that can flash white during a transition, and
 * all four have to be painted for the flash to go away:
 *
 *   1. the native root window, set once per theme via expo-system-ui
 *   2. the view behind the navigator, the wrapper below
 *   3. react-navigation's own theme, whose default background is near-white
 *      regardless of our palette
 *   4. each screen's content container, via contentStyle
 *
 * Screen-to-screen navigation then uses no animation, matching gym junkie. The
 * add screen keeps a slide, since a modal appearing instantly reads as a glitch.
 */
function ThemedStack() {
  const { colors, scheme } = useTheme();

  const navigationTheme = useMemo<Theme>(() => {
    const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        background: colors.bg,
        card: colors.bg,
        text: colors.text,
        border: colors.border,
        primary: colors.accent,
      },
    };
  }, [scheme, colors.bg, colors.text, colors.border, colors.accent]);

  useEffect(() => {
    // Paints the window underneath React Native itself, which is what shows
    // through during the moment a native screen is being swapped in.
    void SystemUI.setBackgroundColorAsync(colors.bg).catch(() => {});
  }, [colors.bg]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <NavigationThemeProvider value={navigationTheme}>
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.bg },
            headerTitleStyle: { color: colors.text },
            headerTintColor: colors.accent,
            headerShadowVisible: false,
            contentStyle: { backgroundColor: colors.bg },
            animation: 'none',
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen
            name="add"
            options={{
              title: 'Add code',
              presentation: 'modal',
              animation: 'slide_from_bottom',
            }}
          />
          <Stack.Screen name="folders" options={{ title: 'Folders' }} />
          <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        </Stack>
      </NavigationThemeProvider>
    </View>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ClockProvider>
          <VaultProvider>
            <ThemedStack />
          </VaultProvider>
        </ClockProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
