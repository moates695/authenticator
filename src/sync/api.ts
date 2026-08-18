import { bytesToBase64 } from './base64';
import type { KdfParams } from './keys';
import { syncBaseUrl } from './sync_url';

/**
 * The sync server's HTTP surface. Every binary field travels as standard base64
 * with padding, which is what the server's validator expects.
 *
 * Nothing here knows what any of the blobs mean — that is the point of the
 * design, and it keeps this file to plumbing.
 */

/**
 * Which server this build syncs with — the rule for choosing it, and what a
 * development build has to be told, are in `sync_url.ts`.
 *
 * Expo inlines `EXPO_PUBLIC_*` at bundle time, so this is fixed per build and a
 * change to `.env` needs the bundler restarted.
 */
export const SYNC_BASE_URL = syncBaseUrl(process.env.EXPO_PUBLIC_SYNC_URL, __DEV__);
export { PRODUCTION_SYNC_URL } from './sync_url';

/** Long enough for an overloaded droplet, short enough to fail while the user is still watching. */
const REQUEST_TIMEOUT_MS = 20_000;

export class SyncError extends Error {
  /** The HTTP status, or 0 when the request never got an answer. */
  readonly status: number;
  /** The parsed `detail` body, for the callers that act on its shape (409s). */
  readonly detail: unknown;

  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.name = 'SyncError';
    this.status = status;
    this.detail = detail;
  }

  /** True when retrying later might work, as opposed to needing the user to change something. */
  get isTransient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

type RequestOptions = {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  body?: unknown;
  token?: string;
};

/**
 * Pulls something readable out of a FastAPI error body. `detail` is a string for
 * the errors we raise ourselves, a list of field problems for validation
 * failures, and an object for the 409 that carries the current vault.
 */
function messageFromDetail(detail: unknown, fallback: string): string {
  if (typeof detail === 'string' && detail) return detail;
  if (Array.isArray(detail)) {
    const first = detail[0] as { msg?: unknown } | undefined;
    if (first && typeof first.msg === 'string') return first.msg;
  }
  return fallback;
}

async function request<T>({ method, path, body, token }: RequestOptions): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${SYNC_BASE_URL}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    // Includes the abort above, DNS failure, and no connection at all. None of
    // them tell the user anything useful, so they get one honest message.
    throw new SyncError(
      0,
      (err as Error).name === 'AbortError'
        ? 'The server took too long to answer. Check your connection and try again.'
        : 'Could not reach the sync server. Check your connection and try again.',
    );
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // A body that is not JSON means something in front of the app answered —
      // a proxy error page, most likely. Fall through to the status-based message.
    }
  }

  if (!response.ok) {
    const detail = (parsed as { detail?: unknown } | null)?.detail;
    throw new SyncError(
      response.status,
      messageFromDetail(detail, `The server returned ${response.status}.`),
      detail,
    );
  }

  return parsed as T;
}

// --- Response shapes, mirroring server/app/schemas.py --------------------

export type SessionResponse = {
  user_id: string;
  token: string;
  expires_at: number;
  vault_version: number;
};

/** What a renewal answers with. The token is unchanged — only its deadline moved. */
export type SessionRefreshResponse = {
  user_id: string;
  expires_at: number;
};

export type LoginResponse = SessionResponse & {
  kdf: KdfParams;
  wrapped_passphrase: string;
  wrapped_recovery: string;
};

/**
 * What register and login answer with. Neither issues a session: the passphrase
 * is one factor and a code sent to the address is the other, so the token comes
 * back from `verifyCode` and nowhere else.
 */
export type ChallengeResponse = {
  challenge_id: string;
  email: string;
  purpose: 'register' | 'login';
  /** Unix seconds. When the digits in the inbox stop working. */
  code_expires_at: number;
  /** Unix seconds. When the challenge dies and the passphrase is needed again. */
  expires_at: number;
};

/** True when the challenge itself is gone, rather than just the code on it. */
export function isChallengeGone(error: unknown): boolean {
  return error instanceof SyncError && error.status === 410;
}

/**
 * True when a registration's verify was turned away for carrying no key
 * material — which, because the server checks the code first, is how it says
 * the code itself was right. The code is not spent on such a request, so the
 * same one goes up again with the material behind it.
 *
 * This is the success case of `checkCode`, not an error to report.
 */
export function isMaterialRequired(error: unknown): boolean {
  if (!(error instanceof SyncError) || error.status !== 400) return false;
  return (error.detail as { reason?: unknown } | null)?.reason === 'material_required';
}

export type VaultResponse = {
  version: number;
  /** Null until some device has pushed for the first time. */
  ciphertext: string | null;
  updated_at: number;
};

export type VaultPutResponse = {
  version: number;
  updated_at: number;
};

/** The body of a 409 from `putVault`, so the caller can merge without a second fetch. */
export type VersionConflict = {
  reason: 'version_mismatch';
  version: number;
  ciphertext: string | null;
  updated_at: number;
};

export function isVersionConflict(error: unknown): error is SyncError & { detail: VersionConflict } {
  if (!(error instanceof SyncError) || error.status !== 409) return false;
  const detail = error.detail as Partial<VersionConflict> | null;
  return !!detail && detail.reason === 'version_mismatch' && typeof detail.version === 'number';
}

// --- Endpoints -----------------------------------------------------------

export async function health(): Promise<boolean> {
  try {
    const body = await request<{ status: string }>({ method: 'GET', path: '/health' });
    return body.status === 'ok';
  } catch {
    return false;
  }
}

/** Both derivations' parameters for an account: the light one and the slow one. */
export type PreloginParams = {
  /** The encryption key's, used after the code comes back. */
  kdf: KdfParams;
  /** The auth key's, used before the code can be asked for. */
  authKdf: KdfParams;
};

/** Answers for any address, known or not, so it cannot be used to enumerate accounts. */
export async function prelogin(email: string): Promise<PreloginParams> {
  const body = await request<{ kdf: KdfParams; auth_kdf: KdfParams }>({
    method: 'POST',
    path: '/v1/prelogin',
    body: { email },
  });
  return { kdf: body.kdf, authKdf: body.auth_kdf };
}

/**
 * Asks for the code that will create the account. Nothing else is sent — the
 * key material goes up with `verifyCode` — so this returns in a round trip and
 * the slow derivation can run while the code is making its way to the inbox.
 */
export function register(email: string): Promise<ChallengeResponse> {
  return request<ChallengeResponse>({
    method: 'POST',
    path: '/v1/register',
    body: { email },
  });
}

/** What a registration's verify carries beyond the code: what the account is made of. */
export type RegistrationUpload = {
  authKey: Uint8Array;
  kdf: KdfParams;
  authKdf: KdfParams;
  wrappedPassphrase: Uint8Array;
  wrappedRecovery: Uint8Array;
};

/**
 * Checks the passphrase half and sends the code for the other half. The auth key
 * comes from the light derivation, so this is reached in a moment rather than
 * after the several seconds the encryption key takes — that one runs once the
 * code has been answered.
 */
export function login(email: string, authKey: Uint8Array): Promise<ChallengeResponse> {
  return request<ChallengeResponse>({
    method: 'POST',
    path: '/v1/login',
    body: { email, auth_key: bytesToBase64(authKey) },
  });
}

/**
 * Answers a challenge with the six digits from the email. The only call that
 * returns a session, for a registration as much as for a sign-in — and for a
 * registration, the call that creates the account: the code proves the address
 * and `registration` is what the account is made of, in one step.
 *
 * The code is spent either way: right, and the challenge is consumed; wrong too
 * many times, and it is destroyed.
 */
export function verifyCode(
  challengeId: string,
  code: string,
  registration?: RegistrationUpload,
): Promise<LoginResponse> {
  return request<LoginResponse>({
    method: 'POST',
    path: '/v1/verify',
    body: {
      challenge_id: challengeId,
      code,
      ...(registration
        ? {
            auth_key: bytesToBase64(registration.authKey),
            kdf: registration.kdf,
            auth_kdf: registration.authKdf,
            wrapped_passphrase: bytesToBase64(registration.wrappedPassphrase),
            wrapped_recovery: bytesToBase64(registration.wrappedRecovery),
          }
        : {}),
    },
  });
}

/**
 * Asks a registration's challenge whether its code is right, without creating
 * the account: the same request as above minus the key material, which the
 * server checks for only after the code.
 *
 * Always rejects. `isMaterialRequired` on what comes back means the code was
 * right and is still unspent; anything else is the genuine refusal — a wrong
 * code, an expired one, or a challenge that is over.
 */
export function checkCode(challengeId: string, code: string): Promise<LoginResponse> {
  return verifyCode(challengeId, code);
}

/**
 * A fresh code on the same challenge, which the previous one stops working the
 * moment it is issued. The returned challenge id replaces the one held.
 */
export function resendCode(challengeId: string): Promise<ChallengeResponse> {
  return request<ChallengeResponse>({
    method: 'POST',
    path: '/v1/verify/resend',
    body: { challenge_id: challengeId },
  });
}

/**
 * Puts the full term back on the session. Called when the device's own unlock
 * check has been passed, which is what keeps a phone in regular use from being
 * asked for an emailed code again.
 *
 * A 401 means the session is genuinely over; anything else is a bad connection
 * and the token in hand is still good.
 */
export function refreshSession(token: string): Promise<SessionRefreshResponse> {
  return request<SessionRefreshResponse>({
    method: 'POST',
    path: '/v1/session/refresh',
    token,
  });
}

export function logout(token: string): Promise<void> {
  return request<void>({ method: 'POST', path: '/v1/logout', token });
}

export function getVault(token: string): Promise<VaultResponse> {
  return request<VaultResponse>({ method: 'GET', path: '/v1/vault', token });
}

export function putVault(
  token: string,
  baseVersion: number,
  ciphertext: Uint8Array,
): Promise<VaultPutResponse> {
  return request<VaultPutResponse>({
    method: 'PUT',
    path: '/v1/vault',
    token,
    body: { base_version: baseVersion, ciphertext: bytesToBase64(ciphertext) },
  });
}

export function putKeys(
  token: string,
  body: {
    currentAuthKey: Uint8Array;
    newAuthKey: Uint8Array;
    kdf: KdfParams;
    authKdf: KdfParams;
    wrappedPassphrase: Uint8Array;
    wrappedRecovery: Uint8Array;
  },
): Promise<SessionResponse> {
  return request<SessionResponse>({
    method: 'PUT',
    path: '/v1/keys',
    token,
    body: {
      current_auth_key: bytesToBase64(body.currentAuthKey),
      new_auth_key: bytesToBase64(body.newAuthKey),
      kdf: body.kdf,
      auth_kdf: body.authKdf,
      wrapped_passphrase: bytesToBase64(body.wrappedPassphrase),
      wrapped_recovery: bytesToBase64(body.wrappedRecovery),
    },
  });
}

export function deleteAccount(token: string, authKey: Uint8Array): Promise<void> {
  return request<void>({
    method: 'POST',
    path: '/v1/account/delete',
    token,
    body: { auth_key: bytesToBase64(authKey) },
  });
}
