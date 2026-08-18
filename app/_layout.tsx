import { useEffect, useMemo, type ReactNode } from 'react';
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
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { LockProvider, useAppLock } from '@/auth/lock';
import { LockScreen } from '@/auth/lock_screen';
import { ClockProvider } from '@/otp/clock';
import { AccountProvider, useAccount } from '@/sync/account';
import { RecoveryKeyScreen } from '@/sync/recovery_key_screen';
import { SessionKeeper } from '@/sync/session_keeper';
import { SignInScreen } from '@/sync/sign_in_screen';
import { VerifyEmailScreen } from '@/sync/verify_email_screen';
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

  return (
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
        {/* Title is replaced with the code's own name once the entry loads. */}
        <Stack.Screen name="entry/[id]" options={{ title: 'Code settings' }} />
      </Stack>
    </NavigationThemeProvider>
  );
}

/**
 * Last child of the root view, so it paints over the navigator rather than
 * replacing it. Mounted only while the app is shut, which is what resets the
 * lock screen's own state between lockings.
 */
function LockCover() {
  const { state } = useAppLock();
  return state === 'unlocked' ? null : <LockScreen />;
}

/**
 * The account gate, drawn over the navigator on the same principle as the lock.
 *
 * The navigator stays mounted underneath rather than being swapped out: expo-
 * router wants a navigator present from the first render, and covering it means
 * signing in does not have to rebuild the whole tree to reveal it.
 *
 * Nothing behind the gate is reachable, and the vault provider is remounted per
 * account, so a sign-in that installs a different data key always re-reads from
 * disk rather than showing the previous account's decrypted state.
 */
function AccountGate() {
  const { state, pendingVerification, pendingRecoveryKey } = useAccount();

  if (state === 'checking') return null;
  if (state === 'signed_out') {
    // A code is outstanding: the passphrase has been proved and the second
    // factor has not, which is still signed out as far as everything else here
    // is concerned.
    return pendingVerification ? <VerifyEmailScreen /> : <SignInScreen />;
  }
  if (pendingRecoveryKey) return <RecoveryKeyScreen />;
  return null;
}

function AppShell() {
  const { colors, scheme } = useTheme();
  const { account } = useAccount();

  useEffect(() => {
    // Paints the window underneath React Native itself, which is what shows
    // through during the moment a native screen is being swapped in.
    void SystemUI.setBackgroundColorAsync(colors.bg).catch(() => {});
  }, [colors.bg]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <VaultProvider key={account?.user_id ?? 'signed-out'}>
        <ThemedStack />
      </VaultProvider>
      <AccountGate />
      {/* Outermost cover: the device check comes before anything of ours. */}
      <LockCover />
      {/* Draws nothing; turns passing that check into a renewed session. */}
      <SessionKeeper />
    </View>
  );
}

/**
 * Wires the account into the lock, which is why the account provider is the
 * outer of the two.
 *
 * The lock guards a signed-in account and nothing else: with nobody signed in
 * there is no vault to open — the data key is not on the device until an account
 * installs it — so a fingerprint prompt in front of the sign-in screen would ask
 * the user to prove themselves to reach a screen that then asks them to prove
 * themselves properly. `null` while the account is still being read back keeps
 * the lock from deciding before the answer is in.
 */
function LockGate({ children }: { children: ReactNode }) {
  const { state } = useAccount();
  return (
    <LockProvider guarded={state === 'checking' ? null : state === 'signed_in'}>
      {children}
    </LockProvider>
  );
}

export default function RootLayout() {
  return (
    // Gesture handler has to sit outermost for the swipe on a code row to be
    // recognised at all.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <AccountProvider>
            <LockGate>
              <ClockProvider>
                <AppShell />
              </ClockProvider>
            </LockGate>
          </AccountProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
