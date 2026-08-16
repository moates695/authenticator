/** The droplet. What a shipped app talks to, and nothing else by default. */
export const PRODUCTION_SYNC_URL = 'https://authenticator.moates.com.au';

/**
 * Which server this build syncs with.
 *
 * A development build has to say. The obvious rule — fall back to production
 * whenever nothing is configured — means every account made while testing a
 * sign-up lands in the live database next to real ones, and the only warning is
 * a hostname in small type at the bottom of the sign-in screen. Pointing a
 * development build at production is a reasonable thing to want; it is not a
 * reasonable thing to do by accident, so it is spelt out in `.env` like any
 * other choice.
 *
 * A release build has no `.env` to read, so it keeps the plain default.
 *
 * @throws in development when nothing is configured, which is a red screen at
 * startup rather than a surprise in the production database.
 */
export function syncBaseUrl(configured: string | undefined, development: boolean): string {
  const chosen = configured?.trim();
  // Trailing slashes matter: every path here starts with one.
  if (chosen) return chosen.replace(/\/+$/, '');
  if (!development) return PRODUCTION_SYNC_URL;

  throw new Error(
    'EXPO_PUBLIC_SYNC_URL is not set, and a development build does not fall back' +
      ' to production. Put your local server in .env — or ' +
      PRODUCTION_SYNC_URL +
      ' if that is genuinely what you want — then restart the bundler, since Expo' +
      ' inlines this at bundle time.',
  );
}
