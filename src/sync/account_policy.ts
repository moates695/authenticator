/**
 * The rules behind the sync account, kept apart from the provider in
 * `account.tsx` and the network calls in `api.ts` so each can be checked alone.
 *
 * The account is not optional. A device holding one-time codes and nothing else
 * is one drop away from locking its owner out of everything those codes protect,
 * so the app does not open until there is somewhere for them to be backed up.
 */

/**
 * Long enough that Argon2id has something to defend, short enough that people
 * will actually pick one they can remember. There is no reset: this passphrase
 * and the recovery key are the only two ways back in.
 */
export const MIN_PASSPHRASE_LENGTH = 12;

export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * A deliberately loose check. The server validates properly; all this has to do
 * is catch the obvious typo before we spend a round trip and a derivation on an
 * address that was never going to be accepted.
 */
export function isValidEmail(raw: string): boolean {
  const email = normaliseEmail(raw);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

/**
 * How a passphrase being chosen rates, worst to best. `blocked` cannot be used
 * to create an account; everything above it can, with the colour telling the
 * user how much better they could do.
 *
 * Signing in never rates: the passphrase either unwraps the backup or it does
 * not, and an account made before this scale existed must still get in.
 */
export type PassphraseTier = 'blocked' | 'weak' | 'good' | 'superior';

/**
 * Guessing-entropy thresholds, in bits, between the tiers.
 *
 * The estimate below is deliberately naive — no dictionary, no leak lists — so
 * these are set against what the estimate says about known shapes, not against
 * a real cracking model:
 *
 * - below `WEAK`: a single repeated or stepped character run. Rejected outright,
 *   because the minimum length was plainly met in bad faith.
 * - `GOOD`: a couple of unrelated words, or the minimum length with mixed
 *   character classes.
 * - `SUPERIOR`: what a password generator produces — twenty-odd mixed-class
 *   characters, or six-plus random words. The variety requirement stops a long
 *   typed sentence from rating as generated; `SUPERIOR_ANY_CLASSES` is the
 *   length at which even one class is beyond guessing anyway.
 */
const TIER_BITS = {
  WEAK: 28,
  GOOD: 60,
  SUPERIOR: 100,
  SUPERIOR_ANY_CLASSES: 160,
} as const;

const CHARACTER_CLASSES = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/] as const;

/** Alphabet sizes matching `CHARACTER_CLASSES`; the last is the printable-symbol count. */
const CLASS_POOL_SIZES = [26, 26, 10, 33] as const;

/**
 * A rough guess at how hard a passphrase is to brute-force: length times bits
 * per character for the classes in use, with characters that repeat or step
 * from their neighbour ("aaa", "abc", "321") nearly discounted, so padding a
 * short passphrase with a held-down key buys almost nothing.
 *
 * This over-rates strings of real words — it has no dictionary — which is why
 * the tier thresholds above are calibrated per shape rather than read as true
 * bits of entropy.
 */
function estimatedBits(passphrase: string): number {
  const pool = CHARACTER_CLASSES.reduce(
    (size, re, index) => size + (re.test(passphrase) ? CLASS_POOL_SIZES[index] : 0),
    0,
  );
  if (pool === 0) return 0;

  let effectiveLength = 0;
  for (let i = 0; i < passphrase.length; i++) {
    const step = i === 0 ? NaN : passphrase.charCodeAt(i) - passphrase.charCodeAt(i - 1);
    effectiveLength += Math.abs(step) <= 1 ? 0.25 : 1;
  }
  return effectiveLength * Math.log2(pool);
}

export function passphraseStrength(passphrase: string): PassphraseTier {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) return 'blocked';
  // A handful of characters cycled for length ("abcabcabc…") can out-run the
  // per-character discount below if repeated far enough. No real passphrase is
  // this monotonous at twelve-plus characters.
  if (new Set(passphrase).size <= 3) return 'blocked';

  const bits = estimatedBits(passphrase);
  const classes = CHARACTER_CLASSES.filter((re) => re.test(passphrase)).length;

  if (bits < TIER_BITS.WEAK) return 'blocked';
  if (bits >= TIER_BITS.SUPERIOR_ANY_CLASSES) return 'superior';
  if (bits >= TIER_BITS.SUPERIOR && classes >= 3) return 'superior';
  if (bits >= TIER_BITS.GOOD) return 'good';
  return 'weak';
}

/**
 * Returns what is wrong with a passphrase, or null if nothing is.
 *
 * `confirmation` is only supplied when creating an account — signing in has one
 * field, because a mistyped passphrase there simply fails to unwrap. Its
 * presence is also what turns the length and strength barriers on: only a
 * passphrase being chosen now has to clear them.
 *
 * Signing in takes whatever is typed and lets the server answer. Holding a short
 * one back would be telling someone their own passphrase is invalid when the
 * only useful answer is whether it unwraps the backup, and an account made
 * before these rules existed must still get in.
 */
export function passphraseProblem(passphrase: string, confirmation?: string): string | null {
  if (passphrase.length === 0) return 'Enter a passphrase.';
  if (confirmation === undefined) return null;

  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return `Use at least ${MIN_PASSPHRASE_LENGTH} characters. A few unrelated words works well.`;
  }
  if (passphraseStrength(passphrase) === 'blocked') {
    return 'That passphrase is too predictable. A few unrelated words works well.';
  }
  if (passphrase !== confirmation) {
    return 'The two passphrases do not match.';
  }
  return null;
}

/**
 * The emailed second factor. Six digits, because that is what people will
 * retype off a screen; the server holds it to five minutes and a handful of
 * guesses, which is what makes six enough.
 */
export const VERIFICATION_CODE_LENGTH = 6;

/**
 * Keeps only the digits, and only as many as a code has. People paste codes
 * with the spaces the email put in them, and on Android the SMS-style autofill
 * hands over whatever it thought it saw.
 */
export function normaliseCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, VERIFICATION_CODE_LENGTH);
}

export function isCompleteCode(raw: string): boolean {
  return normaliseCode(raw).length === VERIFICATION_CODE_LENGTH;
}

/**
 * A challenge in flight: the server has sent a code and is waiting for it.
 *
 * The keys derived on the way here are held separately, in memory only. This
 * is the part the screen is allowed to see.
 */
export type PendingVerification = {
  challengeId: string;
  email: string;
  /** Which wording the screen uses, and what happens once the code lands. */
  purpose: 'register' | 'login';
  /** Unix seconds, both of them. The code expires well before the challenge does. */
  codeExpiresAt: number;
  expiresAt: number;
};

/** Whole seconds left before a deadline, floored at zero. */
export function secondsRemaining(deadline: number, nowSeconds: number): number {
  return Math.max(0, Math.floor(deadline - nowSeconds));
}

/** `4:05`, for a countdown that has to be read at a glance. */
export function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

/** What the device remembers about the account between launches. */
export type StoredAccount = {
  user_id: string;
  email: string;
};

/**
 * A server session, kept apart from the account record because the two have
 * different lifetimes: the account is what this device is enrolled as, the
 * session is how long that enrolment is good for without being used.
 *
 * The window slides. Every renewal moves `expires_at` on by another full term,
 * so a phone opened regularly is asked for an emailed code once, and a phone
 * left in a drawer for a fortnight is asked again.
 */
export type StoredSession = {
  token: string;
  /** Unix seconds, as the server reports it. */
  expires_at: number;
  /**
   * When this device last had the session renewed. Zero for a record written
   * before renewals existed, which reads as "due", and that is the right answer
   * for it.
   */
  refreshed_at: number;
};

/**
 * How long a session is left alone before the next unlock renews it.
 *
 * An authenticator is opened for a few seconds at a time, many times a day.
 * Renewing on every one of those would be a request per glance at a code, and
 * buys nothing: what matters is that a device in use never approaches the end
 * of its term, and six hours against a fortnight is a wide margin.
 */
export const SESSION_REFRESH_INTERVAL_SECONDS = 6 * 60 * 60;

export function refreshDue(
  session: StoredSession | null,
  nowSeconds: number,
  intervalSeconds = SESSION_REFRESH_INTERVAL_SECONDS,
): boolean {
  if (!session) return false;
  // A clock that has moved backwards since the last renewal makes the stored
  // time meaningless. Renewing is the harmless way to be wrong about it.
  if (nowSeconds < session.refreshed_at) return true;
  return nowSeconds - session.refreshed_at >= intervalSeconds;
}

export function parseStoredAccount(raw: string | null): StoredAccount | null {
  const parsed = parseJson(raw);
  if (!parsed) return null;

  const { user_id, email } = parsed as Partial<StoredAccount>;
  if (typeof user_id !== 'string' || typeof email !== 'string') return null;
  if (!user_id || !email) return null;

  return { user_id, email };
}

export function parseStoredSession(raw: string | null): StoredSession | null {
  const parsed = parseJson(raw);
  if (!parsed) return null;

  const { token, expires_at, refreshed_at } = parsed as Partial<StoredSession>;
  if (typeof token !== 'string' || typeof expires_at !== 'number') return null;
  if (!token || !Number.isFinite(expires_at)) return null;

  // Absent on a record written before renewals existed. Zero puts the next
  // unlock in charge of setting it properly.
  const refreshed =
    typeof refreshed_at === 'number' && Number.isFinite(refreshed_at) ? refreshed_at : 0;

  return { token, expires_at, refreshed_at: refreshed };
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Whether a stored session can still be used, with a margin so a token that
 * expires mid-request is treated as already gone.
 */
export function sessionIsLive(
  session: StoredSession | null,
  nowSeconds: number,
  marginSeconds = 60,
): boolean {
  return session !== null && session.expires_at - marginSeconds > nowSeconds;
}

/** Where the app is, as far as the account gate is concerned. */
export type AccountState =
  /** Still reading what is stored. Nothing is shown yet. */
  | 'checking'
  /** No account on this device. The gate is up and nothing behind it is mounted. */
  | 'signed_out'
  /** Enrolled. The vault opens, whether or not the server is reachable. */
  | 'signed_in';

/**
 * Development override, read from `EXPO_PUBLIC_DEV_AUTO_LOGIN` alongside a
 * `EXPO_PUBLIC_DEV_ACCOUNT_EMAIL` / `EXPO_PUBLIC_DEV_ACCOUNT_PASSPHRASE` pair.
 * Expo inlines `EXPO_PUBLIC_*` at bundle time, so this is fixed per build.
 *
 * It signs in for real against whichever server the build points at, rather than
 * faking a session: a bypass that skipped the key derivation would leave the
 * device with no data key, and would mean the path being tested is not the path
 * that ships. What it saves is retyping a passphrase on every reload.
 *
 * Returns null unless the flag and both credentials are present, so a build that
 * ships without them cannot be talked into an automatic sign-in.
 */
export type DevAutoLogin = { email: string; passphrase: string };

export function devAutoLogin(
  flag: string | undefined,
  email: string | undefined,
  passphrase: string | undefined,
): DevAutoLogin | null {
  if (flag !== '1' && flag !== 'true') return null;
  if (!email || !passphrase) return null;
  if (!isValidEmail(email)) return null;

  return { email: normaliseEmail(email), passphrase };
}
