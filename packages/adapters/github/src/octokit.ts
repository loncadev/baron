import { CredentialPermissionError, type PortName } from '@lonca/baron-core';
import { Octokit } from 'octokit';
import { GITHUB_PROVIDER } from './provider.js';

/**
 * The permission GitHub itself says the route needs. Fine-grained tokens get
 * `x-accepted-github-permissions` (`contents=write`); classic tokens get `x-accepted-oauth-scopes`
 * (`repo`). Reading it back beats hardcoding a route→permission table that drifts.
 */
export function acceptedPermission(
  headers: Record<string, string | undefined>,
): string | undefined {
  const fineGrained = headers['x-accepted-github-permissions'];
  if (typeof fineGrained === 'string' && fineGrained.length > 0) return fineGrained;
  const classic = headers['x-accepted-oauth-scopes'];
  if (typeof classic === 'string' && classic.length > 0) return `scope ${classic}`;
  return undefined;
}

/**
 * The REST API version every request declares.
 *
 * Left unset, GitHub picks `2022-11-28` — which it deprecated on 2026-03-10 and will remove on
 * 2028-03-10, announcing it with a `Deprecation` header on every write. `@octokit/request` logs that
 * header verbatim, so a line about a scheduled removal printed above the line saying the run
 * succeeded, in output an agent parses and a new user reads.
 *
 * Pinning is the fix rather than muting the logger: it removes the cause instead of the symptom, and
 * it stops a future change of GitHub's default from silently changing how Baron reads a response.
 * The fields Baron reads (issue number/title/state/type/labels/assignee/body, PR
 * draft/state/merged/head) were checked against both versions before this moved.
 */
export const GITHUB_API_VERSION = '2026-03-10';

/**
 * Build an Octokit for this adapter.
 *
 * With a `port`, permission refusals become an error a human can act on: GitHub answers a forbidden
 * write with "Resource not accessible by personal access token", which names neither the operation
 * nor the permission that would fix it — the message that made a failed `task-start` unreadable. The
 * route's required permission is in the response headers, so the fix is read back from GitHub rather
 * than hardcoded into a route table that would drift.
 *
 * Without one, refusals pass through raw. That is for the two callers that must classify a 403
 * themselves — the credential probe, whose entire job is telling 403 from 422, and introspection,
 * which treats an unreadable route as an absent feature.
 */
export function createGithubOctokit(token: string, port?: PortName): Octokit {
  const octokit = new Octokit({ auth: token });

  // A before-hook, not a constructor option: @octokit/core ignores `headers` (it sets only
  // user-agent and time-zone), and reassigning `octokit.request` afterwards would miss every
  // `octokit.rest.*` method, which is bound to the original.
  octokit.hook.before('request', (options) => {
    options.headers = { ...options.headers, 'x-github-api-version': GITHUB_API_VERSION };
  });

  if (port === undefined) return octokit;

  octokit.hook.error('request', async (error, options) => {
    const status = (error as { status?: unknown }).status;
    if (status !== 403) throw error;
    const response = (error as { response?: { headers?: unknown } }).response;
    const headers =
      typeof response?.headers === 'object' && response.headers !== null
        ? (response.headers as Record<string, string | undefined>)
        : {};
    throw new CredentialPermissionError(
      GITHUB_PROVIDER,
      port,
      `${options.method} ${options.url}`,
      acceptedPermission(headers),
      error.message,
    );
  });

  return octokit;
}
