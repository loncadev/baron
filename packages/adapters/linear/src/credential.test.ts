import { describe, expect, it } from 'vitest';
import { createLinearCredentialProbe } from './credential.js';

/** A fetch that answers each call with a queued GraphQL payload. */
function fakeFetch(payloads: unknown[]): typeof fetch {
  return (async () => ({ json: async () => payloads.shift() ?? {} })) as unknown as typeof fetch;
}

const probe = (payloads: unknown[]) =>
  createLinearCredentialProbe({ apiKey: 'k', team: 'BAR', fetchImpl: fakeFetch(payloads) });

describe('the Linear credential probe', () => {
  it('confirms read by performing one, and requires the configured team to be visible', async () => {
    const [found] = await probe([{ data: { teams: { nodes: [{ id: 't' }] } } }]).probe([
      'issues:read',
    ]);
    expect(found?.status).toBe('granted');

    // Authenticating is not the same as being able to work: every create needs the team, so a key
    // that reads fine but cannot see it is refused rather than passed.
    const [blind] = await probe([{ data: { teams: { nodes: [] } } }]).probe(['issues:read']);
    expect(blind?.status).toBe('denied');
    expect(blind?.detail).toMatch(/sees no team/);
  });

  it('reads a write grant from a rejection on the ID, not from performing a write', async () => {
    // The mutation targets an id nothing can have. Getting as far as "not found" proves the key was
    // authorized to attempt it — and proves it without changing anything.
    const [write] = await probe([{ errors: [{ message: 'Entity not found: Issue' }] }]).probe([
      'issues:write',
    ]);
    expect(write?.status).toBe('granted');
  });

  it('reads a refusal as denied', async () => {
    const [write] = await probe([
      { errors: [{ message: 'You do not have permission to perform this action' }] },
    ]).probe(['issues:write']);
    expect(write?.status).toBe('denied');
    expect(write?.detail).toMatch(/permission/);
  });

  it('says unknown rather than guessing when the response fits neither pattern', async () => {
    // The point of the whole design. A probe that guesses converts "nobody checked" into "checked,
    // and wrong" — which is worse than the gap it was added to close.
    const [write] = await probe([{ errors: [{ message: 'Rate limit exceeded' }] }]).probe([
      'issues:write',
    ]);
    expect(write?.status).toBe('unknown');
    expect(write?.detail).toMatch(/Rate limit exceeded/);
  });

  it('refuses to call an unexpected success a grant', async () => {
    // Nothing exists at that id, so success means the assumption behind the probe is wrong. Reporting
    // a grant nobody established would be the exact failure this is guarding against.
    const [write] = await probe([{ data: { issueUpdate: { success: true } } }]).probe([
      'issues:write',
    ]);
    expect(write?.status).toBe('unknown');
  });
});
