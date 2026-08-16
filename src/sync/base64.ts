/**
 * Standard base64 with padding, which is what the sync API speaks.
 *
 * React Native gives us neither `Buffer` nor a dependable `btoa`, and the server
 * decodes with `validate=True`, so the padding is not optional. Thirty lines
 * here is cheaper than another dependency for a format this stable.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Reverse lookup, built once. -1 marks a byte that is not a base64 digit. */
const VALUES = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i += 1) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';

  for (let i = 0; i < bytes.length; i += 3) {
    const remaining = bytes.length - i;
    const chunk = (bytes[i] << 16) | ((remaining > 1 ? bytes[i + 1] : 0) << 8) | (remaining > 2 ? bytes[i + 2] : 0);

    out += ALPHABET[(chunk >> 18) & 63];
    out += ALPHABET[(chunk >> 12) & 63];
    out += remaining > 1 ? ALPHABET[(chunk >> 6) & 63] : '=';
    out += remaining > 2 ? ALPHABET[chunk & 63] : '=';
  }

  return out;
}

export function base64ToBytes(text: string): Uint8Array {
  const body = text.endsWith('==') ? text.slice(0, -2) : text.endsWith('=') ? text.slice(0, -1) : text;

  // Every 4 characters carry 3 bytes; a 2- or 3-character tail carries 1 or 2.
  if (body.length % 4 === 1) throw new Error('Not valid base64: truncated');

  const out = new Uint8Array(Math.floor((body.length * 3) / 4));
  let written = 0;
  let accumulator = 0;
  let bits = 0;

  for (let i = 0; i < body.length; i += 1) {
    const code = body.charCodeAt(i);
    const value = code < 128 ? VALUES[code] : -1;
    if (value < 0) throw new Error(`Not valid base64: unexpected ${JSON.stringify(body[i])}`);

    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written] = (accumulator >> bits) & 0xff;
      written += 1;
    }
  }

  return out;
}
