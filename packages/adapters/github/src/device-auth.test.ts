import { describe, expect, it, vi } from 'vitest';
import { createGithubDeviceAuth } from './device-auth.js';

/** A fetch that replays a queue of JSON bodies, recording what it was asked. */
function fakeFetch(bodies: unknown[]): typeof fetch & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const impl = (async (_url: unknown, init: { body?: string } = {}) => {
    calls.push(JSON.parse(init.body ?? '{}'));
    return { json: async () => bodies.shift() ?? {} };
  }) as unknown as typeof fetch & { calls: Array<Record<string, unknown>> };
  impl.calls = calls;
  return impl;
}

const auth = (bodies: unknown[]) => {
  const fetchImpl = fakeFetch(bodies);
  return {
    fetchImpl,
    device: createGithubDeviceAuth({
      clientId: 'cid',
      fetchImpl,
      sleep: async () => {},
    }),
  };
};

const CODE = {
  device_code: 'dev-1',
  user_code: 'ABCD-1234',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
};

describe('github device flow', () => {
  it('shows the user their code, then returns the token once approved', async () => {
    const { device } = auth([CODE, { error: 'authorization_pending' }, { access_token: 'gho_x' }]);
    const prompt = vi.fn();

    expect(await device.authorize(prompt)).toBe('gho_x');
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ userCode: 'ABCD-1234', verificationUri: CODE.verification_uri }),
    );
  });

  it('carries the pre-filled verification URL through when the provider offers one', async () => {
    // GitHub puts the code in the query string of verification_uri_complete, which is what lets a
    // CLI open a page the user only has to confirm. It is optional in the spec, so it is surfaced
    // alongside the plain URL rather than instead of it.
    const complete = 'https://github.com/login/device?user_code=ABCD-1234';
    const { device } = auth([
      { ...CODE, verification_uri_complete: complete },
      { access_token: 'gho_x' },
    ]);
    const prompt = vi.fn();
    await device.authorize(prompt);
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        verificationUri: CODE.verification_uri,
        verificationUriComplete: complete,
      }),
    );
  });

  it('leaves the pre-filled URL unset when the provider omits it, rather than inventing one', async () => {
    // Guessing the query-string shape would produce a URL that looks authoritative and may not work.
    const { device } = auth([CODE, { access_token: 'gho_x' }]);
    const prompt = vi.fn();
    await device.authorize(prompt);
    expect(prompt.mock.calls[0]?.[0]).not.toHaveProperty('verificationUriComplete');
  });

  it('sends no client secret — which is why a CLI can do this at all', async () => {
    const { device, fetchImpl } = auth([CODE, { access_token: 'gho_x' }]);
    await device.authorize(() => {});
    for (const call of fetchImpl.calls) {
      expect(Object.keys(call)).not.toContain('client_secret');
    }
    expect(fetchImpl.calls[0]).toMatchObject({ client_id: 'cid', scope: 'repo' });
  });

  it('backs off when GitHub says slow_down rather than hammering it', async () => {
    const sleeps: number[] = [];
    const fetchImpl = fakeFetch([CODE, { error: 'slow_down' }, { access_token: 'gho_x' }]);
    const device = createGithubDeviceAuth({
      clientId: 'cid',
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await device.authorize(() => {});
    expect(sleeps[0]).toBe(5000);
    expect(sleeps[1]).toBe(10000);
  });

  it('reports a denial with what GitHub said, not a generic failure', async () => {
    const { device } = auth([
      CODE,
      { error: 'access_denied', error_description: 'The user denied the request.' },
    ]);
    await expect(device.authorize(() => {})).rejects.toThrow(/denied/i);
  });

  it('refuses when GitHub returns no code at all, naming the likely cause', async () => {
    const { device } = auth([{ error: 'unauthorized_client' }]);
    await expect(device.authorize(() => {})).rejects.toThrow(/device flow/i);
  });

  it('gives up when the code expires instead of polling forever', async () => {
    // expires_in 0 means the deadline is already past when the first poll would happen.
    const { device } = auth([{ ...CODE, expires_in: 0 }]);
    await expect(device.authorize(() => {})).rejects.toThrow(/expired/i);
  });
});
