import {
  MIN_PASSPHRASE_LENGTH,
  VERIFICATION_CODE_LENGTH,
  devAutoLogin,
  formatCountdown,
  isCompleteCode,
  isValidEmail,
  normaliseCode,
  normaliseEmail,
  parseStoredAccount,
  parseStoredSession,
  passphraseProblem,
  passphraseStrength,
  refreshDue,
  secondsRemaining,
  sessionIsLive,
  SESSION_REFRESH_INTERVAL_SECONDS,
  type StoredSession,
} from './account_policy';

describe('email handling', () => {
  it('lowercases and trims, matching what the server stores', () => {
    expect(normaliseEmail('  Marcus@Example.COM ')).toBe('marcus@example.com');
  });

  it.each(['me@example.com', 'first.last+tag@sub.example.co.uk'])('accepts %p', (email) => {
    expect(isValidEmail(email)).toBe(true);
  });

  it.each(['', 'me', 'me@', '@example.com', 'me@example', 'a b@example.com'])(
    'rejects %p',
    (email) => {
      expect(isValidEmail(email)).toBe(false);
    },
  );

  it('rejects an address longer than the addressing standard allows', () => {
    expect(isValidEmail(`${'a'.repeat(250)}@example.com`)).toBe(false);
  });
});

describe('passphrase rules', () => {
  it('asks for one when the field is empty', () => {
    expect(passphraseProblem('')).toMatch(/enter a passphrase/i);
  });

  it('rejects anything under the minimum when creating', () => {
    const short = 'a'.repeat(MIN_PASSPHRASE_LENGTH - 1);
    expect(passphraseProblem(short, short)).toMatch(
      new RegExp(`${MIN_PASSPHRASE_LENGTH} characters`),
    );
  });

  it('accepts one at exactly the minimum', () => {
    const minimum = 'my dog Spot!';
    expect(minimum).toHaveLength(MIN_PASSPHRASE_LENGTH);
    expect(passphraseProblem(minimum, minimum)).toBeNull();
  });

  it('takes any non-empty passphrase at sign-in, however short', () => {
    expect(passphraseProblem('abc')).toBeNull();
  });

  it('only compares against a confirmation when one is supplied', () => {
    const passphrase = 'correct horse battery staple';
    expect(passphraseProblem(passphrase)).toBeNull();
    expect(passphraseProblem(passphrase, passphrase)).toBeNull();
    expect(passphraseProblem(passphrase, `${passphrase}!`)).toMatch(/do not match/i);
  });

  it('treats a mismatch as worth reporting even when both are long enough', () => {
    expect(passphraseProblem('correct horse battery', 'correct horse cattery')).toMatch(
      /do not match/i,
    );
  });

  it('blocks a predictable passphrase when creating, before comparing confirmations', () => {
    expect(passphraseProblem('a'.repeat(20), 'a'.repeat(20))).toMatch(/too predictable/i);
  });

  it('does not rate at sign-in, where an old account must still get in', () => {
    expect(passphraseProblem('a'.repeat(20))).toBeNull();
  });
});

describe('passphrase strength', () => {
  it.each([
    ['too short however varied', 'kX9#mQ2v'],
    ['a held-down key at the minimum length', 'a'.repeat(MIN_PASSPHRASE_LENGTH)],
    ['a keyboard walk of digits', '123456789012'],
    ['a repeated character padded past the minimum', 'a'.repeat(24)],
    ['two characters alternated for length', 'ababababababab'],
    ['three characters cycled for length', 'abcabcabcabcabcabcabc'],
  ])('blocks %s', (_label, passphrase) => {
    expect(passphraseStrength(passphrase)).toBe('blocked');
  });

  it.each([
    ['random lowercase at the minimum length', 'qzjxkvbwmpfh'],
    ['a common shape with a digit run', 'password1234'],
  ])('rates %s as weak', (_label, passphrase) => {
    expect(passphraseStrength(passphrase)).toBe('weak');
  });

  it.each([
    ['a few unrelated words', 'correct horse battery staple'],
    ['the minimum length with mixed classes', 'my dog Spot!'],
  ])('rates %s as good', (_label, passphrase) => {
    expect(passphraseStrength(passphrase)).toBe('good');
  });

  it.each([
    ['a generated mixed-class password', 'kX9#mQ2vLp8@Rt4zWn6&'],
    ['a long run of random words', 'wobble ferret cactus mango drizzle plinth'],
  ])('rates %s as superior', (_label, passphrase) => {
    expect(passphraseStrength(passphrase)).toBe('superior');
  });

  it('keeps a long typed sentence out of the generated tier', () => {
    expect(passphraseStrength('i like my coffee black')).toBe('good');
  });
});

describe('verification codes', () => {
  it('keeps the digits out of a code pasted with the spacing from the email', () => {
    expect(normaliseCode(' 123 456 ')).toBe('123456');
    expect(normaliseCode('123-456')).toBe('123456');
  });

  it('stops at the length of a code, so a stray keystroke cannot lengthen one', () => {
    expect(normaliseCode('1234567')).toBe('123456');
  });

  it('keeps leading zeros, which are as likely as any other digit', () => {
    expect(normaliseCode('000042')).toBe('000042');
    expect(isCompleteCode('000042')).toBe(true);
  });

  it.each(['', '1', '12345', 'abcdef', '12345a'])('is not complete at %p', (raw) => {
    expect(isCompleteCode(raw)).toBe(false);
  });

  it('is complete at exactly the code length', () => {
    expect(isCompleteCode('9'.repeat(VERIFICATION_CODE_LENGTH))).toBe(true);
  });
});

describe('countdowns', () => {
  it('reports what is left, and never less than nothing', () => {
    expect(secondsRemaining(1_000, 700)).toBe(300);
    expect(secondsRemaining(1_000, 1_000)).toBe(0);
    expect(secondsRemaining(1_000, 1_200)).toBe(0);
  });

  it('formats as minutes and padded seconds', () => {
    expect(formatCountdown(300)).toBe('5:00');
    expect(formatCountdown(65)).toBe('1:05');
    expect(formatCountdown(9)).toBe('0:09');
    expect(formatCountdown(0)).toBe('0:00');
  });
});

describe('stored account', () => {
  it('reads back what was written', () => {
    const account = { user_id: 'abc123', email: 'me@example.com' };
    expect(parseStoredAccount(JSON.stringify(account))).toEqual(account);
  });

  it.each([
    ['nothing stored', null],
    ['not json', 'not json at all'],
    ['a bare string', '"hello"'],
    ['a missing id', '{"email":"me@example.com"}'],
    ['an empty id', '{"user_id":"","email":"me@example.com"}'],
    ['a numeric id', '{"user_id":1,"email":"me@example.com"}'],
  ])('returns null for %s', (_label, raw) => {
    expect(parseStoredAccount(raw)).toBeNull();
  });
});

describe('stored session', () => {
  const session = (over: Partial<StoredSession> = {}): StoredSession => ({
    token: 'tok',
    expires_at: 1_800_000_000,
    refreshed_at: 1_799_000_000,
    ...over,
  });

  it('reads back what was written', () => {
    expect(parseStoredSession(JSON.stringify(session()))).toEqual(session());
  });

  it('treats a record written before renewals existed as due for one', () => {
    const stored = parseStoredSession('{"token":"tok","expires_at":1800000000}');
    expect(stored).toEqual(session({ refreshed_at: 0 }));
    expect(refreshDue(stored, 1_799_999_000)).toBe(true);
  });

  it.each([
    ['nothing stored', null],
    ['a missing expiry', '{"token":"tok"}'],
    ['a string expiry', '{"token":"tok","expires_at":"soon"}'],
    ['an empty token', '{"token":"","expires_at":1800000000}'],
  ])('returns null for %s', (_label, raw) => {
    expect(parseStoredSession(raw)).toBeNull();
  });

  it('counts a session as live only while it has margin left', () => {
    const live = session({ expires_at: 1_000 });
    expect(sessionIsLive(live, 0)).toBe(true);
    expect(sessionIsLive(live, 900)).toBe(true);
    // Inside the 60-second margin: it could expire mid-request.
    expect(sessionIsLive(live, 950)).toBe(false);
    expect(sessionIsLive(live, 1_200)).toBe(false);
  });

  it('counts a missing session as not live', () => {
    expect(sessionIsLive(null, 0)).toBe(false);
  });
});

describe('session renewal', () => {
  const at = (refreshed_at: number): StoredSession => ({
    token: 'tok',
    expires_at: refreshed_at + 14 * 24 * 3_600,
    refreshed_at,
  });

  it('leaves a session alone until the interval has passed', () => {
    const stored = at(1_000_000);
    expect(refreshDue(stored, 1_000_000)).toBe(false);
    expect(refreshDue(stored, 1_000_000 + SESSION_REFRESH_INTERVAL_SECONDS - 1)).toBe(false);
    expect(refreshDue(stored, 1_000_000 + SESSION_REFRESH_INTERVAL_SECONDS)).toBe(true);
  });

  it('renews when the clock has gone backwards, since the record cannot be trusted', () => {
    expect(refreshDue(at(1_000_000), 900_000)).toBe(true);
  });

  it('has nothing to renew without a session', () => {
    expect(refreshDue(null, 1_000_000)).toBe(false);
  });
});

describe('development auto sign-in', () => {
  const email = 'dev@example.com';
  const passphrase = 'a development passphrase';

  it.each(['1', 'true'])('is on when the flag is %p and both credentials are set', (flag) => {
    expect(devAutoLogin(flag, email, passphrase)).toEqual({ email, passphrase });
  });

  it('normalises the address the same way a typed one is', () => {
    expect(devAutoLogin('1', '  DEV@Example.com ', passphrase)?.email).toBe(email);
  });

  it.each([
    ['the flag is missing', undefined, email, passphrase],
    ['the flag is off', '0', email, passphrase],
    ['the flag is any other value', 'yes', email, passphrase],
    ['there is no email', '1', undefined, passphrase],
    ['there is no passphrase', '1', email, undefined],
    ['the email is empty', '1', '', passphrase],
    ['the email is malformed', '1', 'not-an-address', passphrase],
  ])('is off when %s', (_label, flag, address, secret) => {
    expect(devAutoLogin(flag, address, secret)).toBeNull();
  });
});
