import {
  type AuthorizedCredential,
  BaronError,
  type DeviceAuth,
  type DeviceCodePrompt,
} from '@lonca/baron-core';

// The contract moved to the core once a second provider (Linear, with a local callback) needed
// it; re-exported here so existing imports keep resolving.
export type { DeviceAuth, DeviceCodePrompt };

export interface GithubDeviceAuthOptions {
  /**
   * The OAuth App or GitHub App client id. Public by design — the device flow has no client secret,
   * which is exactly why a CLI can use it without operating a server.
   */
  readonly clientId: string;
  /**
   * Scopes to request. Only meaningful for an OAuth App; a GitHub App grants the permissions it was
   * installed with and ignores this. `repo` is the narrowest single scope that covers issues,
   * contents and pull requests — broader than a fine-grained PAT, which is the honest trade for not
   * making the user assemble one.
   */
  readonly scope?: string;
  /** Injected for tests. Defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injected for tests so polling does not really wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Baron's own OAuth App, registered under the `loncadev` org.
 *
 * Shipping an id is what makes the device flow actually happen: without one it is never offered, and
 * every user has to register an app before they can avoid registering a token — one chore for
 * another. Every comparable CLI ships one (gh, VS Code, Docker), and it is safe to because the
 * device flow has NO client secret: the id is public by construction, and holding it lets an
 * attacker start a flow the victim still has to approve in their own browser.
 *
 * Tokens are per-user. Each person authorizes this app themselves, the token lands in their own
 * `.baron/credentials`, and it never reaches whoever registered the app. The corresponding
 * responsibility is real: the app appears in every user's authorized-applications list, and deleting
 * it drops everyone's token at once — which is why it lives in the org and not a personal account.
 *
 * `BARON_GITHUB_CLIENT_ID` overrides it; setting that to empty opts out of the offer entirely.
 */
export const BARON_GITHUB_CLIENT_ID = 'Ov23liWMo83LU7TGifWW';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const DEFAULT_SCOPE = 'repo';
/** GitHub's floor when it does not say; it asks for a longer one via `slow_down`. */
const DEFAULT_INTERVAL_SECONDS = 5;

const AUTH_CODE = 'DEVICE_AUTH_FAILED';

interface DeviceCodeResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
}

interface TokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

/**
 * GitHub's device flow: the CLI asks for a code, the user approves it in a browser, and the token
 * comes back with the permissions the app declared. No client secret, so no server — which is what
 * makes it available to a local tool at all. `gh` works the same way.
 */
export function createGithubDeviceAuth(options: GithubDeviceAuthOptions): DeviceAuth {
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  async function post<T>(url: string, body: Record<string, string>): Promise<T> {
    const response = await doFetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await response.json()) as T;
  }

  return {
    async authorize(onPrompt): Promise<AuthorizedCredential> {
      const started = await post<DeviceCodeResponse>(DEVICE_CODE_URL, {
        client_id: options.clientId,
        scope: options.scope ?? DEFAULT_SCOPE,
      });
      if (started.device_code === undefined || started.user_code === undefined) {
        throw new BaronError(
          `GitHub refused the device-code request: ${started.error_description ?? started.error ?? 'no code returned'}. ` +
            'Check that the client id belongs to an app with the device flow enabled.',
          AUTH_CODE,
        );
      }

      onPrompt({
        userCode: started.user_code,
        verificationUri: started.verification_uri ?? 'https://github.com/login/device',
        ...(started.verification_uri_complete !== undefined
          ? { verificationUriComplete: started.verification_uri_complete }
          : {}),
        expiresInSeconds: started.expires_in ?? 900,
      });

      // GitHub sets the polling interval and raises it with `slow_down`; polling faster than it asks
      // gets the request rejected, so the interval is theirs to decide, not ours.
      let intervalMs = (started.interval ?? DEFAULT_INTERVAL_SECONDS) * 1000;
      const deadline = Date.now() + (started.expires_in ?? 900) * 1000;

      while (Date.now() < deadline) {
        await sleep(intervalMs);
        const token = await post<TokenResponse>(TOKEN_URL, {
          client_id: options.clientId,
          device_code: started.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        });
        if (typeof token.access_token === 'string' && token.access_token.length > 0) {
          // A GitHub OAuth-app token stands on its own: nothing to refresh, nothing to keep beside it.
          return { token: token.access_token };
        }
        if (token.error === 'authorization_pending') continue;
        if (token.error === 'slow_down') {
          intervalMs += 5000;
          continue;
        }
        // Anything else is terminal: denial, an expired code, a wrong client id. Say which.
        throw new BaronError(
          `GitHub did not issue a token: ${token.error_description ?? token.error ?? 'unknown error'}.`,
          AUTH_CODE,
        );
      }

      throw new BaronError(
        'The device code expired before it was approved. Run `baron init` again.',
        AUTH_CODE,
      );
    },
  };
}
