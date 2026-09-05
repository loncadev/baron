import type { CredentialCapability, CredentialFinding, CredentialProbe } from '@lonca/baron-core';

export interface JiraCredentialProbeOptions {
  readonly site: string;
  readonly email: string;
  readonly apiToken: string;
  /** The project new issues go to. A token that cannot browse it cannot do the work. */
  readonly project: string;
  readonly fetchImpl?: typeof fetch | undefined;
}

/** How Jira words the thing an admin actually grants, so the report needs no translation. */
const NATIVE_PERMISSIONS: Partial<Record<CredentialCapability, string>> = {
  'issues:read': 'Browse Projects on the project',
  'issues:write': 'Edit Issues on the project',
};

/**
 * Live credential probe for Jira Cloud.
 *
 * Reads are confirmed by performing one: fetching the project is exactly the Browse Projects
 * permission every other call needs. Writes are confirmed WITHOUT performing one, by editing an
 * issue key that cannot exist (`<PROJECT>-0`, Jira numbers from 1): Jira authenticates and checks
 * the token before it looks the issue up, so a 404 proves the write was allowed to try and a 401
 * or 403 proves it was not. Anything else comes back `unknown` carrying the status — a probe that
 * guesses converts "nobody checked" into "checked, and wrong".
 */
export function createJiraCredentialProbe(opts: JiraCredentialProbeOptions): CredentialProbe {
  const site = opts.site.replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  const authorization = `Basic ${Buffer.from(`${opts.email}:${opts.apiToken}`).toString('base64')}`;

  const call = (method: string, path: string, body?: unknown) =>
    doFetch(`${site}/rest/api/2${path}`, {
      method,
      headers: {
        authorization,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const finding = (
    capability: CredentialCapability,
    status: CredentialFinding['status'],
    detail: string,
  ): CredentialFinding => ({
    capability,
    status,
    detail,
    ...(NATIVE_PERMISSIONS[capability] !== undefined
      ? { nativePermission: NATIVE_PERMISSIONS[capability] as string }
      : {}),
  });

  return {
    async probe(
      capabilities: readonly CredentialCapability[],
    ): Promise<readonly CredentialFinding[]> {
      const findings: CredentialFinding[] = [];

      for (const capability of capabilities) {
        if (capability === 'issues:read') {
          const response = await call('GET', `/project/${encodeURIComponent(opts.project)}`);
          if (response.ok) {
            findings.push(finding(capability, 'granted', `read project '${opts.project}'`));
          } else if (response.status === 401 || response.status === 403) {
            findings.push(
              finding(
                capability,
                'denied',
                `Jira refused to show project '${opts.project}' (HTTP ${response.status})`,
              ),
            );
          } else if (response.status === 404) {
            // Jira answers 404 for a project the token cannot see AND for one that does not exist;
            // it deliberately does not say which. Either way the work cannot be done.
            findings.push(
              finding(
                capability,
                'denied',
                `no project '${opts.project}' is visible to this token — wrong key, or no Browse Projects permission`,
              ),
            );
          } else {
            findings.push(
              finding(
                capability,
                'unknown',
                `unexpected HTTP ${response.status} reading the project; not assuming`,
              ),
            );
          }
          continue;
        }

        if (capability === 'issues:write') {
          const response = await call('PUT', `/issue/${encodeURIComponent(`${opts.project}-0`)}`, {
            fields: { summary: 'baron credential probe' },
          });
          if (response.status === 404) {
            findings.push(
              finding(
                capability,
                'granted',
                'the write was authorized and rejected only on the issue key',
              ),
            );
          } else if (response.status === 401 || response.status === 403) {
            findings.push(
              finding(capability, 'denied', `Jira refused the write (HTTP ${response.status})`),
            );
          } else if (response.ok) {
            // Nothing should exist at that key, so a success means the assumption behind this
            // probe is wrong. Saying so is better than reporting a grant nobody established.
            findings.push(
              finding(
                capability,
                'unknown',
                'the probe edit unexpectedly succeeded against a non-existent key; not concluding anything',
              ),
            );
          } else {
            findings.push(
              finding(
                capability,
                'unknown',
                `unexpected HTTP ${response.status} on the probe edit; not assuming`,
              ),
            );
          }
          continue;
        }

        // scm:* on Jira: it has no source control, so there is nothing to check and nothing to
        // assume. A policy binding scm to Jira is a mistake the port layer catches, not this.
        findings.push(
          finding(capability, 'unknown', `Jira has no '${capability}' surface to check`),
        );
      }

      return findings;
    },
  };
}
