import * as OTPAuth from 'otpauth';
import * as Crypto from 'expo-crypto';

import {
  DEFAULT_ALGORITHM,
  DEFAULT_DIGITS,
  DEFAULT_PERIOD,
  type Entry,
  type OtpAlgorithm,
  type OtpType,
} from '@/vault/types';

/** Fields an entry needs before it has an id or ordering. */
export type ParsedOtp = {
  issuer: string;
  account: string;
  secret: string;
  type: OtpType;
  algorithm: OtpAlgorithm;
  digits: number;
  period: number;
  counter: number;
};

const ALGORITHMS: OtpAlgorithm[] = ['SHA1', 'SHA256', 'SHA512'];

function normaliseAlgorithm(raw: string | undefined): OtpAlgorithm {
  const upper = (raw ?? '').toUpperCase().replace(/[-\s]/g, '');
  return (ALGORITHMS.find((a) => a === upper) ?? DEFAULT_ALGORITHM) as OtpAlgorithm;
}

/** Base32 with padding and spacing stripped, as users tend to paste it. */
export function normaliseSecret(raw: string): string {
  return raw.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
}

export function isValidSecret(raw: string): boolean {
  const secret = normaliseSecret(raw);
  if (secret.length < 8) return false;
  if (!/^[A-Z2-7]+$/.test(secret)) return false;
  try {
    OTPAuth.Secret.fromBase32(secret);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses an `otpauth://` URI. Throws with a readable message when the URI is
 * malformed or names a scheme we do not support.
 */
export function parseOtpauthUri(uri: string): ParsedOtp {
  const trimmed = uri.trim();
  if (!/^otpauth:\/\//i.test(trimmed)) {
    throw new Error('Not an otpauth:// link');
  }

  let parsed: OTPAuth.TOTP | OTPAuth.HOTP;
  try {
    parsed = OTPAuth.URI.parse(trimmed);
  } catch (err) {
    throw new Error(`Could not read that link: ${(err as Error).message}`);
  }

  const isHotp = parsed instanceof OTPAuth.HOTP;
  const secret = normaliseSecret(parsed.secret.base32);
  if (!isValidSecret(secret)) {
    throw new Error('That link has an invalid secret');
  }

  return {
    issuer: (parsed.issuer ?? '').trim(),
    account: (parsed.label ?? '').trim(),
    secret,
    type: isHotp ? 'hotp' : 'totp',
    algorithm: normaliseAlgorithm(parsed.algorithm),
    digits: parsed.digits ?? DEFAULT_DIGITS,
    period: isHotp ? DEFAULT_PERIOD : ((parsed as OTPAuth.TOTP).period ?? DEFAULT_PERIOD),
    counter: isHotp ? ((parsed as OTPAuth.HOTP).counter ?? 0) : 0,
  };
}

export function toOtpauthUri(entry: Entry): string {
  const common = {
    issuer: entry.issuer,
    label: entry.account || entry.issuer,
    algorithm: entry.algorithm,
    digits: entry.digits,
    secret: OTPAuth.Secret.fromBase32(entry.secret),
  };

  const otp =
    entry.type === 'hotp'
      ? new OTPAuth.HOTP({ ...common, counter: entry.counter })
      : new OTPAuth.TOTP({ ...common, period: entry.period });

  return otp.toString();
}

/**
 * Generates the current code. `timestamp` is passed in rather than read here so
 * every row on screen is generated against the same instant.
 */
export function generateCode(entry: Entry, timestamp: number): string {
  const secret = OTPAuth.Secret.fromBase32(entry.secret);

  if (entry.type === 'hotp') {
    return new OTPAuth.HOTP({
      issuer: entry.issuer,
      label: entry.account,
      algorithm: entry.algorithm,
      digits: entry.digits,
      counter: entry.counter,
      secret,
    }).generate();
  }

  return new OTPAuth.TOTP({
    issuer: entry.issuer,
    label: entry.account,
    algorithm: entry.algorithm,
    digits: entry.digits,
    period: entry.period,
    secret,
  }).generate({ timestamp });
}

/** Groups digits into readable halves, e.g. `123456` -> `123 456`. */
export function formatCode(code: string): string {
  if (code.length <= 4) return code;
  const mid = Math.ceil(code.length / 2);
  return `${code.slice(0, mid)} ${code.slice(mid)}`;
}

export function newId(): string {
  return Crypto.randomUUID();
}

/**
 * Builds an entry from parsed OTP fields. Ordering and folder assignment are
 * the caller's job, since they depend on existing vault contents.
 */
export function entryFromParsed(
  parsed: ParsedOtp,
  folder_id: string | null,
  order: number,
): Entry {
  const now = Date.now();
  return {
    id: newId(),
    folder_id,
    issuer: parsed.issuer,
    account: parsed.account,
    secret: parsed.secret,
    type: parsed.type,
    algorithm: parsed.algorithm,
    digits: parsed.digits,
    period: parsed.period,
    counter: parsed.counter,
    order,
    created_at: now,
    updated_at: now,
  };
}

/** True when the entry does not follow the 30-second TOTP window the header ring assumes. */
export function isOffCadence(entry: Entry): boolean {
  return entry.type === 'hotp' || entry.period !== DEFAULT_PERIOD;
}
