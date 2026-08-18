import { PRODUCTION_SYNC_URL, syncBaseUrl } from './sync_url';

const LOCAL = 'http://192.168.0.231:8000';

describe('choosing the sync server', () => {
  it('uses what the build was configured with', () => {
    expect(syncBaseUrl(LOCAL, true)).toBe(LOCAL);
    expect(syncBaseUrl(LOCAL, false)).toBe(LOCAL);
  });

  it('trims the trailing slash, since every path starts with one', () => {
    expect(syncBaseUrl(`${LOCAL}/`, true)).toBe(LOCAL);
    expect(syncBaseUrl(`${LOCAL}///`, true)).toBe(LOCAL);
  });

  it('ignores the whitespace an edited .env leaves behind', () => {
    expect(syncBaseUrl(`  ${LOCAL}  `, true)).toBe(LOCAL);
  });

  it('sends a release build to the droplet, which has no .env to read', () => {
    expect(syncBaseUrl(undefined, false)).toBe(PRODUCTION_SYNC_URL);
    expect(syncBaseUrl('', false)).toBe(PRODUCTION_SYNC_URL);
    expect(syncBaseUrl('   ', false)).toBe(PRODUCTION_SYNC_URL);
  });

  it('refuses to let an unconfigured development build reach production', () => {
    // The whole point: accounts made while testing a sign-up must not land in
    // the live database because nobody set a variable.
    expect(() => syncBaseUrl(undefined, true)).toThrow('EXPO_PUBLIC_SYNC_URL');
    expect(() => syncBaseUrl('', true)).toThrow('EXPO_PUBLIC_SYNC_URL');
    expect(() => syncBaseUrl('   ', true)).toThrow('EXPO_PUBLIC_SYNC_URL');
  });

  it('says how to reach production on purpose, for when that is the intent', () => {
    expect(() => syncBaseUrl(undefined, true)).toThrow(PRODUCTION_SYNC_URL);
  });
});
