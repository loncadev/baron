import { createHash, randomBytes } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import { BaronError, type DeviceAuth, type DeviceCodePrompt } from '@lonca/baron-core';

const AUTHORIZE_URL = 'https://linear.app/oauth/authorize';
const TOKEN_URL = 'https://api.linear.app/oauth/token';
/** Read and write on the user's behalf: what the task-* recipes need and nothing broader. */
const DEFAULT_SCOPE = 'read,write';
/** The callback path the local listener answers on; Linear only checks the whole URI matches. */
const CALLBACK_PATH = '/callback';
/** How long the browser has to come back before the listener gives up. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const ERROR_CODE = 'LINEAR_AUTH';

export interface LinearPkceAuthOptions {
  /**
   * The OAuth application's client id. Public by design: PKCE binds the token exchange to the
   * process that started the flow, which is what lets a CLI do this without a client secret.
   */
  readonly clientId: string;
  /** Comma-separated Linear scopes. Defaults to `read,write`. */
  readonly scope?: string | undefined;
  /** Injected for tests. Defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch | undefined;
  /** How long to wait for the browser to come back. Defaults to ten minutes. */
  readonly timeoutMs?: number | undefined;
}

/** What the provider's browser hop hands back on the callback. */
interface Callback {
  readonly code?: string | undefined;
  readonly state?: string | undefined;
  readonly error?: string | undefined;
}

const base64url = (bytes: Buffer): string => bytes.toString('base64url');

/**
 * The OAuth authorization-code flow with PKCE, against a listener on localhost.
 *
 * Linear has no device flow, so the GitHub shape cannot be copied: there is no code for the user
 * to type. Instead Baron opens a loopback listener on a port of the system's choosing, sends the
 * user to Linear's authorization page with that port in the redirect URI and a PKCE challenge, and
 * waits for Linear to send the browser back with a one-time code. The code is exchanged for a
 * token with the PKCE verifier — proof the exchange comes from the process that started the flow —
 * which is why no client secret is shipped or needed. The `state` value refuses a callback this
 * flow did not start.
 *
 * Returned as {@link DeviceAuth} so `baron init` treats it exactly like GitHub's device flow; the
 * prompt simply carries no user code.
 */
export function createLinearPkceAuth(options: LinearPkceAuthOptions): DeviceAuth {
  const doFetch = options.fetchImpl ?? fetch;
  const scope = options.scope ?? DEFAULT_SCOPE;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async authorize(onPrompt: (prompt: DeviceCodePrompt) => void): Promise<string> {
      const verifier = base64url(randomBytes(32));
      const challenge = base64url(createHash('sha256').update(verifier).digest());
      const state = base64url(randomBytes(16));

      const { server, port, callback } = await listen(timeoutMs);
      const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
      try {
        const url = new URL(AUTHORIZE_URL);
        url.searchParams.set('client_id', options.clientId);
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('scope', scope);
        url.searchParams.set('state', state);
        url.searchParams.set('code_challenge', challenge);
        url.searchParams.set('code_challenge_method', 'S256');
        url.searchParams.set('prompt', 'consent');
        onPrompt({
          verificationUri: url.toString(),
          expiresInSeconds: Math.round(timeoutMs / 1000),
        });

        const answer = await callback;
        if (answer.error !== undefined) {
          throw new BaronError(
            `Linear did not authorize Baron: ${answer.error}. Approve the request in the browser and run \`baron init\` again.`,
            ERROR_CODE,
          );
        }
        if (answer.state !== state) {
          throw new BaronError(
            'Linear sent back a callback this sign-in did not start (state mismatch); refusing it. Run `baron init` again.',
            ERROR_CODE,
          );
        }
        if (answer.code === undefined || answer.code.length === 0) {
          throw new BaronError('Linear sent back no authorization code.', ERROR_CODE);
        }

        const body = new URLSearchParams({
          grant_type: 'authorization_code',
          code: answer.code,
          redirect_uri: redirectUri,
          client_id: options.clientId,
          code_verifier: verifier,
        });
        const response = await doFetch(TOKEN_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: body.toString(),
        });
        const token = (await response.json()) as {
          access_token?: string;
          error?: string;
          error_description?: string;
        };
        if (token.access_token === undefined || token.access_token.length === 0) {
          throw new BaronError(
            `Linear refused the token exchange: ${token.error_description ?? token.error ?? `HTTP ${response.status}`}.`,
            ERROR_CODE,
          );
        }
        return token.access_token;
      } finally {
        server.close();
      }
    },
  };
}

/**
 * A one-shot loopback listener. Bound to 127.0.0.1 on an ephemeral port so nothing on the network
 * can reach it, and answered once: the first request to the callback path settles the flow and
 * the page it returns tells the user to go back to the terminal.
 */
function listen(timeoutMs: number): Promise<{
  server: Server;
  port: number;
  callback: Promise<Callback>;
}> {
  return new Promise((resolveListen, rejectListen) => {
    let settle: ((c: Callback) => void) | undefined;
    let fail: ((e: Error) => void) | undefined;
    const callback = new Promise<Callback>((res, rej) => {
      settle = res;
      fail = rej;
    });
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          error === null
            ? '<!doctype html><title>Baron</title><p>Signed in. You can close this tab and go back to the terminal.</p>'
            : `<!doctype html><title>Baron</title><p>Linear did not authorize Baron (${error}). Go back to the terminal.</p>`,
        );
      settle?.({
        code: url.searchParams.get('code') ?? undefined,
        state: url.searchParams.get('state') ?? undefined,
        error: error ?? undefined,
      });
    });
    const timer = setTimeout(() => {
      fail?.(
        new BaronError(
          `Nobody approved the Linear sign-in within ${Math.round(timeoutMs / 60000)} minutes. Run \`baron init\` again when you are ready.`,
          ERROR_CODE,
        ),
      );
      server.close();
    }, timeoutMs);
    timer.unref();
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        rejectListen(
          new BaronError('Could not open a loopback listener for the sign-in.', ERROR_CODE),
        );
        return;
      }
      server.once('close', () => clearTimeout(timer));
      resolveListen({ server, port: address.port, callback });
    });
  });
}
