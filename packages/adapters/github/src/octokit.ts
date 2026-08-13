import { CredentialPermissionError, type PortName } from '@lonca/baron-core';
import { Octokit } from 'octokit';
import { acceptedPermission } from './credential.js';
import { GITHUB_PROVIDER } from './provider.js';

/**
 * Build an Octokit that turns GitHub's permission refusals into an error a human can act on.
 *
 * GitHub answers a forbidden write with "Resource not accessible by personal access token", which
 * names neither the operation nor the permission that would fix it — the message that made a failed
 * `task-start` unreadable. The route's required permission is in the response headers, so the fix is
 * read back from GitHub rather than hardcoded into a route table that would drift.
 *
 * Introspection and the credential probe deliberately do NOT use this: both need the raw 403 to
 * classify it, and turning it into a thrown error there would defeat the check.
 */
export function createGithubOctokit(token: string, port: PortName): Octokit {
  const octokit = new Octokit({ auth: token });

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
