import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import { palettes, radius, spacing, type Palette, type ThemeName } from './palette';

/** What the user picked; 'system' follows the OS setting. */
export type ThemePreference = 'system' | ThemeName;

const PREFERENCE_KEY = 'theme_preference';

type ThemeContextValue = {
  colors: Palette;
  /** The theme actually in effect, after resolving 'system'. */
  scheme: ThemeName;
  preference: ThemePreference;
  setPreference: (next: ThemePreference) => void;
  spacing: typeof spacing;
  radius: typeof radius;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>('system');

  useEffect(() => {
    SecureStore.getItemAsync(PREFERENCE_KEY)
      .then((stored) => {
        if (stored === 'light' || stored === 'dark' || stored === 'system') {
          setPreferenceState(stored);
        }
      })
      .catch(() => {
        // A missing or unreadable preference just means we stay on 'system'.
      });
  }, []);

  const value = useMemo<ThemeContextValue>(() => {
    const scheme: ThemeName =
      preference === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : preference;

    return {
      colors: palettes[scheme],
      scheme,
      preference,
      setPreference: (next) => {
        setPreferenceState(next);
        void SecureStore.setItemAsync(PREFERENCE_KEY, next).catch(() => {});
      },
      spacing,
      radius,
    };
  }, [preference, systemScheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside a ThemeProvider');
  return ctx;
}
