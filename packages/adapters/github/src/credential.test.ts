import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('octokit', () => ({
  Octokit: vi.fn(() => ({ hook: { before: vi.fn(), error: vi.fn() }, request: mocks.request })),
}));

const { createGithubCredentialProbe } = await import('./credential.js');

const probe = () => createGithubCredentialProbe({ owner: 'acme', repo: 'store', token: 't' });

/** Shape of an Octokit RequestError closely enough for the probe's duck-typed reading. */
function httpError(status: number, message: string, headers: Record<string, string> = {}) {
  return Object.assign(new Error(message), { status, response: { headers } });
}

describe('github credential probe', () => {
  it('confirms a write WITHOUT performing it: an authorized caller is rejected on the body', async () => {
    // GitHub authorizes before it validates, so a deliberately invalid body separates "may not" from
    // "may, but that request was nonsense" — 403 vs 422. Nothing is created either way, which is the
    // only reason this is an acceptable thing for `doctor` to run.
    mocks.request.mockRejectedValue(httpError(422, 'Object does not exist'));
    const [finding] = await probe().probe(['scm:write']);
    expect(finding?.status).toBe('granted');

    const call = mocks.request.mock.calls[0];
    expect(call?.[0]).toBe('POST /repos/{owner}/{repo}/git/refs');
    // A sha of all zeros names no object, so even an authorized call cannot create a ref.
    expect(call?.[1]).toMatchObject({ sha: '0'.repeat(40) });
  });

  it('reports a refused write as denied and names the permission GitHub asked for', async () => {
    mocks.request.mockRejectedValue(
      httpError(403, 'Resource not accessible by personal access token', {
        'x-accepted-github-permissions': 'contents=write',
      }),
    );
    const [finding] = await probe().probe(['scm:write']);
    expect(finding?.status).toBe('denied');
    expect(finding?.nativePermission).toBe('contents=write');
    expect(finding?.detail).toContain('not accessible');
  });

  it("falls back to GitHub's own permission wording when the provider says nothing", async () => {
    mocks.request.mockRejectedValue(httpError(403, 'nope'));
    const [finding] = await probe().probe(['issues:write']);
    expect(finding?.status).toBe('denied');
    expect(finding?.nativePermission).toBe('Issues: Read and write');
  });

  it('reads the classic-token scope header when the fine-grained one is absent', async () => {
    mocks.request.mockRejectedValue(httpError(403, 'nope', { 'x-accepted-oauth-scopes': 'repo' }));
    const [finding] = await probe().probe(['scm:write']);
    expect(finding?.nativePermission).toBe('scope repo');
  });

  it('confirms a read by performing it', async () => {
    mocks.request.mockResolvedValue({ data: {} });
    const [finding] = await probe().probe(['scm:read']);
    expect(finding?.status).toBe('granted');
  });

  it('treats an unexpected status as unknown rather than granted', async () => {
    mocks.request.mockRejectedValue(httpError(500, 'server error'));
    const [finding] = await probe().probe(['scm:write']);
    expect(finding?.status).toBe('unknown');
    expect(finding?.detail).toContain('500');
  });
});
