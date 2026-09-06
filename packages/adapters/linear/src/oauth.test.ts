import { describe, expect, it } from 'vitest';
import { expiresAt, isExpired } from './oauth.js';
import { createLinearTransport } from './transport.js';

/** A fetch that records every request and answers from a queue, by URL family. */
function fakeFetch(answers: { graphql: unknown[]; token: unknown[] }) {
  const sent: Array<{ url: string; authorization: string | undefined; form?: URLSearchParams }> =
    [];
  const fetchImpl = (async (
    url: string,
    init: { body?: string; headers?: Record<string, string> } = {},
  ) => {
    const isToken = url.endsWith('/oauth/token');
    sent.push({
      url,
      authorization: init.headers?.authorization,
      ...(isToken ? { form: new URLSearchParams(init.body ?? '') } : {}),
    });
    const body = isToken ? answers.token.shift() : answers.graphql.shift();
    return { status: 200, json: async () => body ?? {} };
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

const ISSUE = {
  id: 'i1',
  identifier: 'BAR-1',
  title: 'x',
  state: { id: 's', name: 'Todo', type: 'unstarted' },
  team: { id: 't', key: 'BAR' },
  labels: { nodes: [] },
};
const okIssue = { data: { issue: ISSUE } };
const refusal = { errors: [{ message: 'authentication required' }] };

describe('a browser-issued Linear token in the transport', () => {
  it('is sent as Bearer, where a personal key is sent bare', async () => {
    const asKey = fakeFetch({ graphql: [okIssue], token: [] });
    await createLinearTransport({
      apiKey: 'lin_api_k',
      team: 'BAR',
      fetchImpl: asKey.fetchImpl,
    }).getIssue('i1');
    expect(asKey.sent[0]?.authorization).toBe('lin_api_k');

    const asToken = fakeFetch({ graphql: [okIssue], token: [] });
    await createLinearTransport({
      apiKey: 'lin_oauth_a',
      team: 'BAR',
      oauth: { refreshToken: 'r1', clientId: 'cid', expiresAt: expiresAt(3600) },
      fetchImpl: asToken.fetchImpl,
    }).getIssue('i1');
    expect(asToken.sent[0]?.authorization).toBe('Bearer lin_oauth_a');
  });

  it('renews before using a token it knows is expiring, and writes the rotated pair back', async () => {
    const { fetchImpl, sent } = fakeFetch({
      graphql: [okIssue],
      token: [{ access_token: 'lin_oauth_b', refresh_token: 'r2', expires_in: 86399 }],
    });
    const persisted: Array<Record<string, string>> = [];
    const transport = createLinearTransport({
      apiKey: 'lin_oauth_a',
      team: 'BAR',
      oauth: {
        refreshToken: 'r1',
        clientId: 'cid',
        expiresAt: expiresAt(30), // inside the one-minute margin
        persist: (patch) => {
          persisted.push({ ...patch });
        },
      },
      fetchImpl,
    });
    await transport.getIssue('i1');

    // The renewal came first, with the refresh token and client id and no secret.
    expect(sent[0]?.url).toBe('https://api.linear.app/oauth/token');
    expect(sent[0]?.form?.get('grant_type')).toBe('refresh_token');
    expect(sent[0]?.form?.get('refresh_token')).toBe('r1');
    expect(sent[0]?.form?.get('client_id')).toBe('cid');
    expect(sent[0]?.form?.get('client_secret')).toBeNull();
    // Then the request, with the new token.
    expect(sent[1]?.authorization).toBe('Bearer lin_oauth_b');
    // And the rotated pair reached the file, under the keys init stored the originals under.
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      LINEAR_API_KEY: 'lin_oauth_b',
      LINEAR_REFRESH_TOKEN: 'r2',
    });
    expect(Date.parse(persisted[0]?.LINEAR_TOKEN_EXPIRES_AT as string)).toBeGreaterThan(Date.now());
  });

  it('renews once when Linear refuses a token it thought was valid, then takes the answer', async () => {
    const { fetchImpl, sent } = fakeFetch({
      graphql: [refusal, okIssue],
      token: [{ access_token: 'lin_oauth_b', refresh_token: 'r2', expires_in: 86399 }],
    });
    const transport = createLinearTransport({
      apiKey: 'lin_oauth_a',
      team: 'BAR',
      oauth: { refreshToken: 'r1', clientId: 'cid', expiresAt: expiresAt(3600) },
      fetchImpl,
    });
    const issue = await transport.getIssue('i1');
    expect(issue.key).toBe('BAR-1');
    expect(sent.map((s) => (s.form ? 'refresh' : s.authorization))).toEqual([
      'Bearer lin_oauth_a',
      'refresh',
      'Bearer lin_oauth_b',
    ]);
  });

  it('does not loop on a refusal that a renewal did not fix', async () => {
    const { fetchImpl, sent } = fakeFetch({
      graphql: [refusal, refusal],
      token: [{ access_token: 'lin_oauth_b', refresh_token: 'r2' }],
    });
    const transport = createLinearTransport({
      apiKey: 'lin_oauth_a',
      team: 'BAR',
      oauth: { refreshToken: 'r1', clientId: 'cid' },
      fetchImpl,
    });
    await expect(transport.getIssue('i1')).rejects.toThrow(/authentication required/);
    expect(sent).toHaveLength(3);
  });

  it('says to sign in again when Linear will not renew', async () => {
    const { fetchImpl } = fakeFetch({
      graphql: [refusal],
      token: [{ error: 'invalid_grant', error_description: 'Refresh token revoked' }],
    });
    const transport = createLinearTransport({
      apiKey: 'lin_oauth_a',
      team: 'BAR',
      oauth: { refreshToken: 'r1', clientId: 'cid' },
      fetchImpl,
    });
    await expect(transport.getIssue('i1')).rejects.toMatchObject({
      code: 'LINEAR_AUTH',
      message: expect.stringMatching(/Refresh token revoked.*baron init/),
    });
  });

  it('never renews a personal key', async () => {
    const { fetchImpl, sent } = fakeFetch({ graphql: [refusal], token: [] });
    const transport = createLinearTransport({ apiKey: 'lin_api_k', team: 'BAR', fetchImpl });
    await expect(transport.getIssue('i1')).rejects.toThrow(/authentication required/);
    expect(sent).toHaveLength(1);
  });
});

describe('isExpired', () => {
  it('treats an unknown or unparseable expiry as not expired, and a near one as expired', () => {
    const now = Date.parse('2026-09-06T12:00:00Z');
    expect(isExpired(undefined, now)).toBe(false);
    expect(isExpired('not a date', now)).toBe(false);
    expect(isExpired('2026-09-06T13:00:00Z', now)).toBe(false);
    expect(isExpired('2026-09-06T12:00:30Z', now)).toBe(true);
    expect(isExpired('2026-09-06T11:00:00Z', now)).toBe(true);
  });
});
