import type { CredentialCapability, CredentialFinding, CredentialProbe } from '@lonca/baron-core';

export interface LinearCredentialProbeOptions {
  readonly apiKey: string;
  /** The team new issues go to. A key that cannot see it cannot do the work, whatever else it may do. */
  readonly team: string;
  readonly endpoint?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

/**
 * An id no issue can have, so `issueUpdate` is REJECTED on the entity — never performed.
 *
 * Linear ids are UUIDs; a syntactically valid one that names nothing lets the mutation get far
 * enough to be authorized and no further. That is the whole trick: authorization happens before
 * the entity lookup, so the error tells you which of the two failed.
 */
const NONEXISTENT_ID = '00000000-0000-4000-8000-000000000000';

/** How Linear words the thing a user actually grants, so the report needs no translation. */
const NATIVE_PERMISSIONS: Partial<Record<CredentialCapability, string>> = {
  'issues:read': 'read access to the workspace',
  'issues:write': 'write access to the workspace',
};

const AUTH_ERROR = /authentication|not authenticated|unauthorized|forbidden|permission|scope/i;
const MISSING_ENTITY = /not found|does not exist|no such|invalid.*id|entity/i;

/**
 * Live credential probe for Linear.
 *
 * Reads are confirmed by performing one. Writes are confirmed WITHOUT performing one, by attempting
 * a mutation against an id that cannot exist: Linear authorizes before it looks the entity up, so a
 * not-found error proves the key was allowed to try, and an authorization error proves it was not.
 *
 * Anything neither pattern matches comes back `unknown` carrying the provider's own message. That is
 * deliberate and it is the important part — a probe that guesses is worse than no probe, because it
 * converts "nobody checked" into "checked, and wrong", which is precisely the failure the credential
 * check was added to remove.
 */
export function createLinearCredentialProbe(opts: LinearCredentialProbeOptions): CredentialProbe {
  const endpoint = opts.endpoint ?? 'https://api.linear.app/graphql';
  const doFetch = opts.fetchImpl ?? fetch;

  const call = async (query: string, variables?: Record<string, unknown>) => {
    const response = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: opts.apiKey },
      body: JSON.stringify({ query, ...(variables !== undefined ? { variables } : {}) }),
    });
    return (await response.json()) as {
      data?: Record<string, unknown> | null;
      errors?: Array<{ message: string }>;
    };
  };

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
          // Performing the read IS the check. It also asks the question that actually matters on
          // Linear: a key that authenticates but cannot see the configured team is useless here,
          // because every create needs that team.
          const result = await call(
            'query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }',
            { key: opts.team },
          );
          const message = result.errors?.map((e) => e.message).join('; ') ?? '';
          if (message.length > 0) {
            findings.push(finding(capability, 'denied', `Linear refused a read: ${message}`));
            continue;
          }
          const teams = (result.data?.teams as { nodes?: unknown[] } | undefined)?.nodes ?? [];
          findings.push(
            teams.length > 0
              ? finding(capability, 'granted', `read a team matching '${opts.team}'`)
              : finding(
                  capability,
                  'denied',
                  `the key can read, but sees no team '${opts.team}' — every create needs it`,
                ),
          );
          continue;
        }

        if (capability === 'issues:write') {
          const result = await call(
            'mutation($id: String!) { issueUpdate(id: $id, input: { title: "baron credential probe" }) { success } }',
            { id: NONEXISTENT_ID },
          );
          const message = result.errors?.map((e) => e.message).join('; ') ?? '';
          if (message.length === 0) {
            // Nothing should exist at that id, so a success means the assumption behind this probe
            // is wrong. Saying so is better than reporting a grant nobody established.
            findings.push(
              finding(
                capability,
                'unknown',
                'the probe mutation unexpectedly succeeded against a non-existent id; not concluding anything',
              ),
            );
          } else if (AUTH_ERROR.test(message)) {
            findings.push(finding(capability, 'denied', `Linear refused the write: ${message}`));
          } else if (MISSING_ENTITY.test(message)) {
            findings.push(
              finding(
                capability,
                'granted',
                'the write was authorized and rejected only on the id',
              ),
            );
          } else {
            findings.push(
              finding(capability, 'unknown', `unrecognised response, not assuming: ${message}`),
            );
          }
          continue;
        }

        // scm:* on Linear: it has no source control, so there is nothing to check and nothing to
        // assume. A policy binding scm to Linear is a mistake the port layer catches, not this.
        findings.push(
          finding(capability, 'unknown', `Linear has no '${capability}' surface to check`),
        );
      }

      return findings;
    },
  };
}
