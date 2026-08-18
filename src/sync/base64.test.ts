import { base64ToBytes, bytesToBase64 } from './base64';

/** Test vectors from RFC 4648 §10, which pin the padding cases. */
const RFC_4648 = [
  ['', ''],
  ['f', 'Zg=='],
  ['fo', 'Zm8='],
  ['foo', 'Zm9v'],
  ['foob', 'Zm9vYg=='],
  ['fooba', 'Zm9vYmE='],
  ['foobar', 'Zm9vYmFy'],
] as const;

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}

describe('base64', () => {
  it.each(RFC_4648)('encodes %p as %p', (plain, encoded) => {
    expect(bytesToBase64(ascii(plain))).toBe(encoded);
  });

  it.each(RFC_4648)('decodes %p back from %p', (plain, encoded) => {
    expect(Array.from(base64ToBytes(encoded))).toEqual(Array.from(ascii(plain)));
  });

  it('round-trips every byte value', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it('round-trips each length, so no padding case is missed', () => {
    for (let length = 0; length < 20; length += 1) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37) % 256);
      expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it('always pads to a multiple of four, which the server requires', () => {
    for (let length = 1; length < 10; length += 1) {
      expect(bytesToBase64(new Uint8Array(length)).length % 4).toBe(0);
    }
  });

  it('keeps a wrapped data key well inside the server’s 512-byte field cap', () => {
    // A wrapped data key is 1 version + 24 nonce + 32 key + 16 tag = 73 bytes.
    expect(bytesToBase64(new Uint8Array(73))).toHaveLength(100);
    expect(base64ToBytes(bytesToBase64(new Uint8Array(73)))).toHaveLength(73);
  });

  it('rejects characters outside the alphabet', () => {
    expect(() => base64ToBytes('Zm9v!!!!')).toThrow(/not valid base64/i);
  });

  it('rejects a length that cannot be a base64 body', () => {
    expect(() => base64ToBytes('Zm9vY')).toThrow(/truncated/i);
  });
});
