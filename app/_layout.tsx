import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ClockProvider } from '@/otp/clock';
import { ThemeProvider, useTheme } from '@/theme/theme_context';
import { VaultProvider } from '@/vault/vault_store';

/**
 * Lives inside ThemeProvider so navigation chrome picks up the same palette as
 * the screens, in both light and dark mode.
 */
function ThemedStack() {
  const { colors, scheme } = useTheme();

  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTitleStyle: { color: colors.text },
          headerTintColor: colors.accent,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Codes' }} />
        <Stack.Screen name="add" options={{ title: 'Add code', presentation: 'modal' }} />
        <Stack.Screen name="folders" options={{ title: 'Folders' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
      </Stack>
    </>
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
