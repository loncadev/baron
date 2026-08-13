import { CredentialPermissionError } from '@lonca/baron-core';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ before: vi.fn(), error: vi.fn() }));

vi.mock('octokit', () => ({
  Octokit: vi.fn(() => ({ hook: { before: mocks.before, error: mocks.error } })),
}));

const { GITHUB_API_VERSION, acceptedPermission, createGithubOctokit } = await import(
  './octokit.js'
);

/** Run whatever `hook.before('request', …)` was registered against a request-options object. */
function applyBeforeHook(options: Record<string, unknown>): Record<string, unknown> {
  const [event, handler] = mocks.before.mock.calls.at(-1) ?? [];
  expect(event).toBe('request');
  (handler as (o: Record<string, unknown>) => void)(options);
  return options;
}

describe('createGithubOctokit', () => {
  // Left unset, GitHub selects an API version it has already deprecated and announces it with a
  // Deprecation header on every write, which @octokit/request logs verbatim — a scheduled-removal
  // notice printed directly above the line saying the run succeeded.
  it('declares the pinned REST API version on every request', () => {
    createGithubOctokit('t', 'issues');
    const options = applyBeforeHook({ headers: { accept: 'application/vnd.github+json' } });
    expect(options.headers).toMatchObject({ 'x-github-api-version': GITHUB_API_VERSION });
    // and does not clobber what was already there
    expect(options.headers).toMatchObject({ accept: 'application/vnd.github+json' });
  });

  it('pins the version on the raw client too', () => {
    createGithubOctokit('t');
    const options = applyBeforeHook({ headers: {} });
    expect(options.headers).toMatchObject({ 'x-github-api-version': GITHUB_API_VERSION });
  });

  it('installs the permission-error hook only for a bound port', () => {
    mocks.error.mockClear();
    createGithubOctokit('t');
    expect(mocks.error).not.toHaveBeenCalled();
    createGithubOctokit('t', 'scm');
    expect(mocks.error).toHaveBeenCalledTimes(1);
  });

  it('turns a 403 into an error naming the port, the route and the permission', async () => {
    mocks.error.mockClear();
    createGithubOctokit('t', 'scm');
    const handler = mocks.error.mock.calls.at(-1)?.[1] as (
      error: unknown,
      options: unknown,
    ) => Promise<never>;
    const refusal = Object.assign(new Error('Resource not accessible by personal access token'), {
      status: 403,
      response: { headers: { 'x-accepted-github-permissions': 'contents=write' } },
    });

    await expect(
      handler(refusal, { method: 'POST', url: '/repos/{owner}/{repo}/git/refs' }),
    ).rejects.toBeInstanceOf(CredentialPermissionError);
    await expect(
      handler(refusal, { method: 'POST', url: '/repos/{owner}/{repo}/git/refs' }),
    ).rejects.toThrow(/scm port.*contents=write/s);
  });

  it('passes any other status through untouched', async () => {
    mocks.error.mockClear();
    createGithubOctokit('t', 'scm');
    const handler = mocks.error.mock.calls.at(-1)?.[1] as (
      error: unknown,
      options: unknown,
    ) => Promise<never>;
    const notFound = Object.assign(new Error('Not Found'), { status: 404 });
    await expect(handler(notFound, { method: 'GET', url: '/x' })).rejects.toBe(notFound);
  });
});

describe('acceptedPermission', () => {
  it('prefers the fine-grained permission GitHub names', () => {
    expect(
      acceptedPermission({
        'x-accepted-github-permissions': 'issues=write',
        'x-accepted-oauth-scopes': 'repo',
      }),
    ).toBe('issues=write');
  });

  it('falls back to the classic scope list', () => {
    expect(acceptedPermission({ 'x-accepted-oauth-scopes': 'repo' })).toBe('scope repo');
  });

  it('is undefined when the provider named neither', () => {
    expect(acceptedPermission({})).toBeUndefined();
  });
});
