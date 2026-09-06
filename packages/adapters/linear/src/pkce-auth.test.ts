import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createLinearPkceAuth } from './pkce-auth.js';

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
    const auth = createLinearPkceAuth({ clientId: 'cid', fetchImpl });
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
    await expect(token).resolves.toBe('lin_oauth_x');

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

  it('refuses a callback this sign-in did not start', async () => {
    const { fetchImpl, calls } = fakeFetch([{ access_token: 'never' }]);
    const auth = createLinearPkceAuth({ clientId: 'cid', fetchImpl });
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

  it("reports Linear's own refusal instead of a missing code", async () => {
    const { fetchImpl } = fakeFetch([]);
    const auth = createLinearPkceAuth({ clientId: 'cid', fetchImpl });
    const token = auth.authorize((prompt) => {
      setTimeout(() => {
        void approve(prompt.verificationUri, (q) => ({
          error: 'access_denied',
          state: q.get('state') as string,
        }));
      }, 10);
    });
    await expect(token).rejects.toThrow(/did not authorize Baron: access_denied/);
  });

  it('gives up when nobody comes back, naming how long it waited', async () => {
    const { fetchImpl } = fakeFetch([]);
    const auth = createLinearPkceAuth({ clientId: 'cid', fetchImpl, timeoutMs: 50 });
    await expect(auth.authorize(() => {})).rejects.toMatchObject({ code: 'LINEAR_AUTH' });
  });

  it('surfaces a refused exchange with the provider’s reason', async () => {
    const { fetchImpl } = fakeFetch([
      { error: 'invalid_grant', error_description: 'Code expired' },
    ]);
    const auth = createLinearPkceAuth({ clientId: 'cid', fetchImpl });
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
