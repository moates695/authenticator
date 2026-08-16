// `api.ts` picks its base URL at import time, and a development build with no
// server configured refuses to guess one — see `sync_url.ts`, which has its own
// tests. Nothing below sends a request, so any address will do.
jest.mock('./sync_url', () => ({
  ...jest.requireActual('./sync_url'),
  syncBaseUrl: () => 'http://localhost:8000',
}));

import { SyncError, isChallengeGone, isMaterialRequired, isVersionConflict } from './api';

/**
 * The shapes the client reads out of a refusal rather than showing. Each is a
 * contract with `server/app/main.py`, so a change to either side that is not
 * matched on the other should fail here.
 */

describe('material required', () => {
  it('recognises the server saying a registration code was right', () => {
    const detail = { reason: 'material_required', message: 'Include it.' };
    expect(isMaterialRequired(new SyncError(400, 'Include it.', detail))).toBe(true);
  });

  it('is not any other 400', () => {
    expect(isMaterialRequired(new SyncError(400, 'Bad request.'))).toBe(false);
    expect(isMaterialRequired(new SyncError(400, 'Bad request.', { reason: 'something' }))).toBe(
      false,
    );
  });

  it('is not a wrong code, which is what it has to be told apart from', () => {
    expect(isMaterialRequired(new SyncError(401, 'That code is not right. 2 tries left.'))).toBe(
      false,
    );
  });

  it('is not an expired code or a dead challenge', () => {
    expect(isMaterialRequired(new SyncError(410, 'That code has expired.'))).toBe(false);
    expect(isMaterialRequired(new SyncError(429, 'Too many incorrect codes.'))).toBe(false);
  });

  it('is not something that is not a SyncError at all', () => {
    expect(isMaterialRequired(new Error('offline'))).toBe(false);
    expect(isMaterialRequired(null)).toBe(false);
  });
});

describe('challenge gone', () => {
  it('is the 410 and nothing else', () => {
    expect(isChallengeGone(new SyncError(410, 'Start again.'))).toBe(true);
    expect(isChallengeGone(new SyncError(401, 'Not right.'))).toBe(false);
  });
});

describe('version conflict', () => {
  it('recognises a 409 carrying the current vault', () => {
    const detail = { reason: 'version_mismatch', version: 4, ciphertext: null, updated_at: 1 };
    expect(isVersionConflict(new SyncError(409, 'Conflict.', detail))).toBe(true);
  });

  it('is not a 409 of some other shape', () => {
    expect(isVersionConflict(new SyncError(409, 'That email is already registered.'))).toBe(false);
  });
});

describe('transient failures', () => {
  it.each([0, 429, 500, 503])('counts %p as worth retrying', (status) => {
    expect(new SyncError(status, 'x').isTransient).toBe(true);
  });

  it.each([400, 401, 409, 410])('counts %p as needing the user to change something', (status) => {
    expect(new SyncError(status, 'x').isTransient).toBe(false);
  });
});
