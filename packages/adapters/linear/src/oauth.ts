import { BaronError } from '@lonca/baron-core';

/**
 * What the PKCE sign-in writes and the transport reads back: the env keys a browser-issued Linear
 * credential is stored under, beside LINEAR_API_KEY. A personal API key has none of these; their
 * presence is what tells the transport it is holding an OAuth token that expires and can be
 * renewed rather than a key that simply works until revoked.
 */
export const LINEAR_REFRESH_TOKEN_KEY = 'LINEAR_REFRESH_TOKEN';
export const LINEAR_TOKEN_EXPIRES_AT_KEY = 'LINEAR_TOKEN_EXPIRES_AT';
/** The application the token was issued to; refreshing needs it, and a secret it does not. */
export const LINEAR_OAUTH_CLIENT_ID_KEY = 'LINEAR_OAUTH_CLIENT_ID';

export const LINEAR_TOKEN_URL = 'https://api.linear.app/oauth/token';

/** An ISO timestamp `expiresIn` seconds from now, which is how the expiry is stored. */
export function expiresAt(expiresInSeconds: number, now: number = Date.now()): string {
  return new Date(now + expiresInSeconds * 1000).toISOString();
}

/** A browser-issued credential as the transport holds it: renewable, and persisted when renewed. */
export interface LinearOAuthSession {
  readonly refreshToken: string;
  /** ISO timestamp; absent means "unknown", which is treated as valid until Linear says otherwise. */
  readonly expiresAt?: string | undefined;
  readonly clientId: string;
  /**
   * Where a rotated pair goes. Linear rotates the refresh token on every use, so a renewal that is
   * not written back is a sign-in that dies with the process. Keyed by the env names `baron init`
   * stored the originals under.
   */
  readonly persist?:
    | ((patch: Readonly<Record<string, string>>) => void | Promise<void>)
    | undefined;
}

/** What a refresh produced, in the shape the session keeps it. */
export interface RefreshedToken {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: string | undefined;
}

/**
 * Trade a refresh token for a new pair. No client secret: a token issued through PKCE is renewed
 * with the client id alone, which is the whole reason a CLI can hold one.
 */
export async function refreshLinearToken(
  doFetch: typeof fetch,
  session: Pick<LinearOAuthSession, 'refreshToken' | 'clientId'>,
  now: number = Date.now(),
): Promise<RefreshedToken> {
  const response = await doFetch(LINEAR_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
      client_id: session.clientId,
    }).toString(),
  });
  const token = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (token.access_token === undefined || token.access_token.length === 0) {
    throw new BaronError(
      `Linear would not renew the sign-in: ${token.error_description ?? token.error ?? `HTTP ${response.status}`}. Run \`baron init\` to sign in again.`,
      'LINEAR_AUTH',
    );
  }
  return {
    accessToken: token.access_token,
    // Rotated on every use per Linear's migration; a response that omits it keeps the old one.
    refreshToken: token.refresh_token ?? session.refreshToken,
    expiresAt: token.expires_in !== undefined ? expiresAt(token.expires_in, now) : undefined,
  };
}

/** True when the stored expiry is past, or within a minute of it — close enough to renew first. */
export function isExpired(expiresAtIso: string | undefined, now: number = Date.now()): boolean {
  if (expiresAtIso === undefined) return false;
  const at = Date.parse(expiresAtIso);
  return Number.isNaN(at) ? false : at - now < 60_000;
}
