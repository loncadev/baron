import { existsSync, readFileSync } from 'node:fs';
import { BaronError, type IssuesPort, parsePolicy, resolveIssuesConfig } from '@baron/core';
import { type Env, buildIssuesPort, policyPath } from '@baron/providers';

/**
 * Load the committed policy and build the live {@link IssuesPort} the server serves. A missing
 * policy is a server-lifecycle failure (POLICY_NOT_FOUND) — only a human running `baron init` can
 * fix it — so it throws here rather than starting a server that errors on every call. Credentials
 * come from `env`, never from the committed policy.
 */
export function loadIssuesPort(root: string, env: Env): IssuesPort {
  const path = policyPath(root);
  if (!existsSync(path)) {
    throw new BaronError(
      `No policy found at ${path}. Run \`baron init\` first.`,
      'POLICY_NOT_FOUND',
    );
  }
  const policy = parsePolicy(JSON.parse(readFileSync(path, 'utf8')));
  const config = resolveIssuesConfig(policy);
  return buildIssuesPort(config, env);
}
