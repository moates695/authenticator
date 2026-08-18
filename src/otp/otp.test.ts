import {
  formatCode,
  generateCode,
  isOffCadence,
  isValidSecret,
  normaliseSecret,
  parseOtpauthUri,
  toOtpauthUri,
} from './otp';
import { DEFAULT_PERIOD, type Entry, type OtpAlgorithm, type OtpType } from '@/vault/types';

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'test-id',
    folder_id: null,
    issuer: 'Example',
    account: 'user@example.com',
    secret: 'JBSWY3DPEHPK3PXP',
    type: 'totp',
    algorithm: 'SHA1',
    digits: 6,
    period: DEFAULT_PERIOD,
    counter: 0,
    order: 0,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

describe('generateCode — RFC 6238 test vectors', () => {
  // Base32 of the RFC's ASCII seeds: "12345678901234567890" extended to the
  // digest length of each algorithm.
  const SEEDS: Record<OtpAlgorithm, string> = {
    SHA1: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    SHA256: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA',
    SHA512:
      'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA',
  };

  const VECTORS: [seconds: number, algorithm: OtpAlgorithm, expected: string][] = [
    [59, 'SHA1', '94287082'],
    [59, 'SHA256', '46119246'],
    [59, 'SHA512', '90693936'],
    [1111111109, 'SHA1', '07081804'],
    [1111111109, 'SHA256', '68084774'],
    [1111111109, 'SHA512', '25091201'],
    [1111111111, 'SHA1', '14050471'],
    [1111111111, 'SHA256', '67062674'],
    [1111111111, 'SHA512', '99943326'],
    [1234567890, 'SHA1', '89005924'],
    [1234567890, 'SHA256', '91819424'],
    [1234567890, 'SHA512', '93441116'],
    [2000000000, 'SHA1', '69279037'],
    [2000000000, 'SHA256', '90698825'],
    [2000000000, 'SHA512', '38618901'],
    [20000000000, 'SHA1', '65353130'],
    [20000000000, 'SHA256', '77737706'],
    [20000000000, 'SHA512', '47863826'],
  ];

  it.each(VECTORS)('T=%i %s produces %s', (seconds, algorithm, expected) => {
    const code = generateCode(
      entry({ secret: SEEDS[algorithm], algorithm, digits: 8, period: 30 }),
      seconds * 1000,
    );
    expect(code).toBe(expected);
  });
});

describe('generateCode', () => {
  it('returns the same code throughout one 30-second window', () => {
    const e = entry();
    const base = 1_700_000_000_000 - (1_700_000_000_000 % 30_000);
    expect(generateCode(e, base)).toBe(generateCode(e, base + 29_999));
  });

  it('returns a different code in the next window', () => {
    const e = entry();
    const base = 1_700_000_000_000 - (1_700_000_000_000 % 30_000);
    expect(generateCode(e, base)).not.toBe(generateCode(e, base + 30_000));
  });

  it('respects the requested digit count', () => {
    expect(generateCode(entry({ digits: 8 }), 1_700_000_000_000)).toHaveLength(8);
    expect(generateCode(entry({ digits: 6 }), 1_700_000_000_000)).toHaveLength(6);
  });

  it('ignores the timestamp for counter-based entries', () => {
    const e = entry({ type: 'hotp', counter: 5 });
    expect(generateCode(e, 1_000)).toBe(generateCode(e, 999_999_999));
  });

  it('changes when the HOTP counter advances', () => {
    const at = 1_700_000_000_000;
    const a = generateCode(entry({ type: 'hotp', counter: 5 }), at);
    const b = generateCode(entry({ type: 'hotp', counter: 6 }), at);
    expect(a).not.toBe(b);
  });
});

describe('normaliseSecret', () => {
  it('strips spaces, dashes and padding, and upper-cases', () => {
    expect(normaliseSecret('jbsw y3dp-ehpk 3pxp==')).toBe('JBSWY3DPEHPK3PXP');
  });
});

describe('isValidSecret', () => {
  it('accepts well-formed base32', () => {
    expect(isValidSecret('JBSWY3DPEHPK3PXP')).toBe(true);
    expect(isValidSecret('jbsw y3dp ehpk 3pxp')).toBe(true);
  });

  it('rejects characters outside the base32 alphabet', () => {
    // 0, 1 and 8 are not in the RFC 4648 base32 alphabet.
    expect(isValidSecret('JBSWY3DPEHPK3PX0')).toBe(false);
    expect(isValidSecret('JBSWY3DP EHPK 3P!!')).toBe(false);
  });

  it('rejects secrets that are too short to be meaningful', () => {
    expect(isValidSecret('JBSW')).toBe(false);
    expect(isValidSecret('')).toBe(false);
  });
});

describe('parseOtpauthUri', () => {
  it('reads a fully specified TOTP link', () => {
    const parsed = parseOtpauthUri(
      'otpauth://totp/GitHub:me%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=8&period=60&algorithm=SHA256',
    );
    expect(parsed).toEqual({
      issuer: 'GitHub',
      account: 'me@example.com',
      secret: 'JBSWY3DPEHPK3PXP',
      type: 'totp',
      algorithm: 'SHA256',
      digits: 8,
      period: 60,
      counter: 0,
    });
  });

  it('falls back to defaults when optional parameters are absent', () => {
    const parsed = parseOtpauthUri('otpauth://totp/Plain?secret=JBSWY3DPEHPK3PXP');
    expect(parsed.digits).toBe(6);
    expect(parsed.period).toBe(30);
    expect(parsed.algorithm).toBe('SHA1');
    expect(parsed.type).toBe('totp');
  });

  it('reads a counter-based link', () => {
    const parsed = parseOtpauthUri(
      'otpauth://hotp/Bank:acct?secret=JBSWY3DPEHPK3PXP&issuer=Bank&counter=17',
    );
    expect(parsed.type).toBe('hotp');
    expect(parsed.counter).toBe(17);
  });

  it('tolerates surrounding whitespace', () => {
    expect(() =>
      parseOtpauthUri('  otpauth://totp/A?secret=JBSWY3DPEHPK3PXP  '),
    ).not.toThrow();
  });

  it('rejects a non-otpauth link', () => {
    expect(() => parseOtpauthUri('https://example.com')).toThrow(/not an otpauth/i);
  });

  it('rejects a Google Authenticator bulk export, which is a different format', () => {
    expect(() => parseOtpauthUri('otpauth-migration://offline?data=AAAA')).toThrow(
      /not an otpauth/i,
    );
  });

  it('rejects a link whose secret is not valid base32', () => {
    expect(() => parseOtpauthUri('otpauth://totp/A?secret=nope!!!!')).toThrow();
  });
});

describe('toOtpauthUri', () => {
  it('round-trips a TOTP entry back through the parser', () => {
    const original = entry({
      issuer: 'GitHub',
      account: 'me@example.com',
      algorithm: 'SHA256',
      digits: 8,
      period: 60,
    });
    const parsed = parseOtpauthUri(toOtpauthUri(original));

    expect(parsed.issuer).toBe(original.issuer);
    expect(parsed.account).toBe(original.account);
    expect(parsed.secret).toBe(original.secret);
    expect(parsed.algorithm).toBe(original.algorithm);
    expect(parsed.digits).toBe(original.digits);
    expect(parsed.period).toBe(original.period);
  });

  it('round-trips an HOTP entry, preserving the counter', () => {
    const parsed = parseOtpauthUri(toOtpauthUri(entry({ type: 'hotp', counter: 9 })));
    expect(parsed.type).toBe('hotp');
    expect(parsed.counter).toBe(9);
  });

  it('produces a URI another authenticator would accept', () => {
    expect(toOtpauthUri(entry())).toMatch(/^otpauth:\/\/totp\//);
  });
});

describe('formatCode', () => {
  it('splits the usual six digits into two groups of three', () => {
    expect(formatCode('123456')).toBe('123 456');
  });

  it('keeps grouping in threes past six digits, leaving a short tail', () => {
    expect(formatCode('12345678')).toBe('123 456 78');
    expect(formatCode('1234567')).toBe('123 456 7');
  });

  it('groups nine digits evenly', () => {
    expect(formatCode('123456789')).toBe('123 456 789');
  });

  it('leaves a code shorter than a group alone', () => {
    expect(formatCode('123')).toBe('123');
  });

  it('never leaves a trailing space', () => {
    for (const code of ['123', '1234', '12345', '123456', '1234567890']) {
      expect(formatCode(code)).toBe(formatCode(code).trim());
    }
  });
});

describe('isOffCadence', () => {
  it('is false for a standard 30-second TOTP entry', () => {
    expect(isOffCadence(entry())).toBe(false);
  });

  it('is true for an unusual period, which the shared ring cannot represent', () => {
    expect(isOffCadence(entry({ period: 60 }))).toBe(true);
  });

  it('is true for counter-based entries, which have no countdown at all', () => {
    expect(isOffCadence(entry({ type: 'hotp' as OtpType }))).toBe(true);
  });
});
