import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { LINEAR_CALLBACK_PORT, createLinearPkceAuth } from './pkce-auth.js';

/** A fetch that records the token exchange and answers with a queued JSON body. */
function fakeFetch(bodies: unknown[]) {
  const calls: Array<{ url: string; form: URLSearchParams; headers: Record<string, string> }> = [];
  const fetchImpl = (async (
    url: string,
    init: { body?: string; headers?: Record<string, string> } = {},
  ) => {
    calls.push({ url, form: new URLSearchParams(init.body ?? ''), headers: init.headers ?? {} });
    return { status: 200, json: async () => bodies.shift() ?? {} };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Play the browser: read the authorization URL Baron showed, then hit its callback like Linear would. */
async function approve(
  verificationUri: string,
  answer: (params: URLSearchParams) => Record<string, string>,
): Promise<string> {
  const url = new URL(verificationUri);
  const redirect = new URL(url.searchParams.get('redirect_uri') as string);
  for (const [key, value] of Object.entries(answer(url.searchParams)))
    redirect.searchParams.set(key, value);
  const page = await fetch(redirect);
  return page.text();
}

describe('the Linear PKCE flow', () => {
  it('sends the user to Linear with a challenge, listens on loopback, and exchanges the code with the verifier', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { access_token: 'lin_oauth_x', refresh_token: 'r', expires_in: 86399 },
    ]);
    const auth = createLinearPkceAuth({ clientId: 'cid', fetchImpl, port: 0 });
    let shown: string | undefined;
    const token = auth.authorize((prompt) => {
      shown = prompt.verificationUri;
      // Nothing to type: the page is the approval, and the caller must not print a code.
      expect(prompt.userCode).toBeUndefined();
      // Play the browser asynchronously, after authorize() has started waiting.
      setTimeout(() => {
        void approve(prompt.verificationUri, (q) => ({
          code: 'auth-code',
          state: q.get('state') as string,
        }));
      }, 10);
    });
    // The refresh token, its expiry and the client id ride along, under the env keys the transport
    // reads them back from — that is what makes the sign-in outlast the 24-hour access token.
    const credential = await token;
    expect(credential.token).toBe('lin_oauth_x');
    expect(credential.extras).toMatchObject({
      LINEAR_REFRESH_TOKEN: 'r',
      LINEAR_OAUTH_CLIENT_ID: 'cid',
    });
    expect(Date.parse(credential.extras?.LINEAR_TOKEN_EXPIRES_AT as string)).toBeGreaterThan(
      Date.now() + 80_000_000,
    );

    const authorize = new URL(shown as string);
    expect(authorize.origin + authorize.pathname).toBe('https://linear.app/oauth/authorize');
    expect(authorize.searchParams.get('client_id')).toBe('cid');
    expect(authorize.searchParams.get('scope')).toBe('read,write');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    );

    // The exchange proves it came from this process — the verifier hashes to the challenge shown —
    // and carries no client secret, which is why a CLI can do this at all.
    const exchange = calls[0];
    expect(exchange?.url).toBe('https://api.linear.app/oauth/token');
    expect(exchange?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(exchange?.form.get('grant_type')).toBe('authorization_code');
    expect(exchange?.form.get('code')).toBe('auth-code');
    expect(exchange?.form.get('redirect_uri')).toBe(authorize.searchParams.get('redirect_uri'));
    expect(exchange?.form.get('client_secret')).toBeNull();
    const verifier = exchange?.form.get('code_verifier') as string;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
      authorize.searchParams.get('code_challenge'),
    );
  });

  it('listens on the fixed, registered port by default — Linear matches the redirect URI exactly', async () => {
    const { fetchImpl } = fakeFetch([{ access_token: 'lin_oauth_x' }]);
    const auth = createLinearPkceAuth({ clientId: 'cid', fetchImpl });
    let shown: string | undefined;
    const token = auth.authorize((prompt) => {
      shown = prompt.verificationUri;
      setTimeout(() => {
        void approve(prompt.verificationUri, (q) => ({
          code: 'auth-code',
          state: q.get('state') as string,
        }));
      }, 10);
    });
    await token;
    expect(new URL(shown as string).searchParams.get('redirect_uri')).toBe(
      `http://127.0.0.1:${LINEAR_CALLBACK_PORT}/callback`,
    );
  });

  it('names the port and the override when the port is taken, instead of a bare EADDRINUSE', async () => {
    const squatter = createServer();
    await new Promise<void>((res) => squatter.listen(0, '127.0.0.1', res));
    const address = squatter.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const { fetchImpl } = fakeFetch([]);
      const auth = createLinearPkceAuth({ clientId: 'cid', fetchImpl, port });
      await expect(auth.authorize(() => {})).rejects.toMatchObject({
        code: 'LINEAR_AUTH',
        message: expect.stringMatching(
          new RegExp(`Port ${port} on 127\.0\.0\.1 is in use.*BARON_LINEAR_CALLBACK_PORT`),
        ),
      });
    } finally {
      squatter.close();
    }
  });

  it('refuses a callback this sign-in did not start', async () => {
    const { fetchImpl, calls } = fakeFetch([{ access_token: 'never' }]);
    const auth = createLinearPkceAuth({ clientId: 'cid', fetchImpl, port: 0 });
    const token = auth.authorize((prompt) => {
      setTimeout(() => {
        void approve(prompt.verificationUri, () => ({ code: 'auth-code', state: 'forged' }));
      }, 10);
    });
    await expect(token).rejects.toMatchObject({
      code: 'LINEAR_AUTH',
      message: expect.stringMatching(/state mismatch/),
    });
    // And exchanges nothing.
    expect(calls).toHaveLength(0);
  });

  it("reports Linear's own refusal instead of a missing code, on the page and in the terminal", async () => {
    const { fetchImpl } = fakeFetch([]);
    const auth = createLinearPkceAuth({ clientId: 'cid', fetchImpl, port: 0 });
    let page: Promise<string> | undefined;
    const token = auth.authorize((prompt) => {
      setTimeout(() => {
        page = approve(prompt.verificationUri, (q) => ({
          error: 'access_denied<b>',
          state: q.get('state') as string,
        }));
      }, 10);
    });
    await expect(token).rejects.toThrow(/did not authorize Baron: access_denied/);
    // The browser is told the same thing — by name, with the reason, and with the reason escaped,
    // since it arrives on the query string.
    const html = await (page as Promise<string>);
    expect(html).toContain('Linear did not authorize Baron');
    expect(html).toContain('access_denied&lt;b&gt;');
    expect(html).not.toContain('access_denied<b>');
  });

  it('answers the browser with a page that says who signed in and what to do next', async () => {
    const { fetchImpl } = fakeFetch([{ access_token: 'lin_oauth_x' }]);
    const auth = createLinearPkceAuth({ clientId: 'cid', fetchImpl, port: 0 });
    let page: Promise<string> | undefined;
    const token = auth.authorize((prompt) => {
      setTimeout(() => {
        page = approve(prompt.verificationUri, (q) => ({
          code: 'auth-code',
          state: q.get('state') as string,
        }));
      }, 10);
    });
    await token;
    const html = await (page as Promise<string>);
    expect(html).toContain('Signed in to Linear');
    expect(html).toContain('go back to the terminal');
    // Self-contained: the listener is gone the moment this is served.
    expect(html).not.toMatch(/src=|href=|@import|url\(/);
  });

  it('gives up when nobody comes back, naming how long it waited', async () => {
    const { fetchImpl } = fakeFetch([]);
    const auth = createLinearPkceAuth({ clientId: 'cid', fetchImpl, timeoutMs: 50, port: 0 });
    await expect(auth.authorize(() => {})).rejects.toMatchObject({ code: 'LINEAR_AUTH' });
  });

  it('surfaces a refused exchange with the provider’s reason', async () => {
    const { fetchImpl } = fakeFetch([
      { error: 'invalid_grant', error_description: 'Code expired' },
    ]);
    const auth = createLinearPkceAuth({ clientId: 'cid', fetchImpl, port: 0 });
    const token = auth.authorize((prompt) => {
      setTimeout(() => {
        void approve(prompt.verificationUri, (q) => ({
          code: 'stale',
          state: q.get('state') as string,
        }));
      }, 10);
    });
    await expect(token).rejects.toThrow(/refused the token exchange: Code expired/);
  });
});
