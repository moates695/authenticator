export type ThemeName = 'light' | 'dark';

/** Semantic colour tokens. Screens reference these, never raw hex. */
export type Palette = {
  bg: string;
  surface: string;
  surfaceAlt: string;
  text: string;
  textMuted: string;
  textFaint: string;
  border: string;
  accent: string;
  accentSoft: string;
  danger: string;
  warn: string;
  success: string;
  /**
   * The tier above `success` on the passphrase strength meter. Purple, so it
   * reads as a different league rather than a greener green.
   */
  superior: string;
  /**
   * Countdown ring colour for the middle urgency band. The final few seconds use
   * `danger` instead.
   */
  expiring: string;
  overlay: string;
};

const light: Palette = {
  bg: '#F4F5F7',
  surface: '#FFFFFF',
  surfaceAlt: '#ECEEF2',
  text: '#12141A',
  textMuted: '#5E6672',
  textFaint: '#9AA2AE',
  border: '#E1E4EA',
  accent: '#2E6BE6',
  accentSoft: '#DCE7FD',
  danger: '#D93A3F',
  warn: '#C77700',
  success: '#1F8A54',
  superior: '#7C3AED',
  expiring: '#D97706',
  overlay: 'rgba(10, 12, 16, 0.45)',
};

const dark: Palette = {
  bg: '#0E1014',
  surface: '#181B21',
  surfaceAlt: '#21252D',
  text: '#F2F4F7',
  textMuted: '#9AA3AF',
  textFaint: '#6B7280',
  border: '#2A2F38',
  accent: '#5B8DEF',
  accentSoft: '#1E2A42',
  danger: '#E5484D',
  warn: '#E6A23C',
  success: '#30A46C',
  superior: '#A78BFA',
  expiring: '#E6A23C',
  overlay: 'rgba(0, 0, 0, 0.6)',
};

export const palettes: Record<ThemeName, Palette> = { light, dark };

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
} as const;
