import type {
  CredentialCapability,
  CredentialFinding,
  CredentialProbe,
  CredentialStatus,
} from '@lonca/baron-core';
import { acceptedPermission, createGithubOctokit } from './octokit.js';
import type { GithubTransportOptions } from './transport.js';

/**
 * GitHub's own name for each permission, worded the way the token screen words it, so the report
 * can be followed without a translation step. `baron init`'s credentials help uses the same words.
 */
const NATIVE_PERMISSIONS: Record<CredentialCapability, string> = {
  'issues:read': 'Issues: Read',
  'issues:write': 'Issues: Read and write',
  'scm:read': 'Contents: Read',
  'scm:write': 'Contents: Read and write',
};

/** A sha of all zeros names no object, so ref creation is rejected on the body — never performed. */
const NONEXISTENT_SHA = '0'.repeat(40);

interface HttpFailure {
  readonly status: number;
  readonly headers: Record<string, string | undefined>;
  readonly message: string;
}

function asHttpFailure(error: unknown): HttpFailure | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  if (typeof status !== 'number') return undefined;
  const response = (error as { response?: { headers?: unknown } }).response;
  const headers =
    typeof response?.headers === 'object' && response.headers !== null
      ? (response.headers as Record<string, string | undefined>)
      : {};
  const message = (error as { message?: unknown }).message;
  return { status, headers, message: typeof message === 'string' ? message : String(error) };
}

/**
 * Live credential probe for GitHub. Reads are confirmed by performing them; writes are confirmed
 * WITHOUT performing them, by sending a request GitHub authorizes before it validates the body — a
 * permitted caller gets 422 (the body is bad), a forbidden one gets 403. Nothing is created either
 * way. This is the only way to answer "can this token write?" for a fine-grained PAT, which unlike
 * a classic token publishes no scope list.
 */
export function createGithubCredentialProbe(options: GithubTransportOptions): CredentialProbe {
  const { owner, repo, token } = options;
  // Deliberately the raw client: this probe's whole job is telling a 403 from a 422, and the
  // permission-error wrapper would turn the first into a thrown error before it could be classified.
  const octokit = createGithubOctokit(token);
  const request = octokit.request as unknown as (
    route: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;

  async function attempt(
    capability: CredentialCapability,
    route: string,
    params: Record<string, unknown>,
    /** Status the provider returns when the call was authorized but the body was refused. */
    authorizedRejection?: number,
  ): Promise<CredentialFinding> {
    const nativePermission = NATIVE_PERMISSIONS[capability];
    try {
      await request(route, { owner, repo, ...params });
      return { capability, status: 'granted', nativePermission };
    } catch (error) {
      const failure = asHttpFailure(error);
      if (failure === undefined) {
        return {
          capability,
          status: 'unknown',
          nativePermission,
          detail: `probe did not complete: ${String(error)}`,
        };
      }
      if (failure.status === 403 || failure.status === 404) {
        // 404 is GitHub hiding a repo the credential cannot see; for a repo the policy names, that
        // is a permission answer, not a missing repo.
        return {
          capability,
          status: 'denied',
          nativePermission: acceptedPermission(failure.headers) ?? nativePermission,
          detail: failure.message,
        };
      }
      if (authorizedRejection !== undefined && failure.status === authorizedRejection) {
        return { capability, status: 'granted', nativePermission };
      }
      const status: CredentialStatus = 'unknown';
      return {
        capability,
        status,
        nativePermission,
        detail: `unexpected HTTP ${failure.status}: ${failure.message}`,
      };
    }
  }

  const PROBES: Record<CredentialCapability, () => Promise<CredentialFinding>> = {
    'issues:read': () =>
      attempt('issues:read', 'GET /repos/{owner}/{repo}/issues', { per_page: 1 }),
    'scm:read': () => attempt('scm:read', 'GET /repos/{owner}/{repo}', {}),
    // No title -> 422 once authorized. Authorization is checked first, so no issue is ever opened.
    'issues:write': () => attempt('issues:write', 'POST /repos/{owner}/{repo}/issues', {}, 422),
    // A ref pointing at a nonexistent object -> 422 once authorized. No ref is ever created.
    'scm:write': () =>
      attempt(
        'scm:write',
        'POST /repos/{owner}/{repo}/git/refs',
        { ref: 'refs/heads/baron-doctor-probe', sha: NONEXISTENT_SHA },
        422,
      ),
  };

  return {
    async probe(
      capabilities: readonly CredentialCapability[],
    ): Promise<readonly CredentialFinding[]> {
      const findings: CredentialFinding[] = [];
      for (const capability of capabilities) {
        findings.push(await PROBES[capability]());
      }
      return findings;
    },
  };
}
