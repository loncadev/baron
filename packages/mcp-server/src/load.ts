import { existsSync, readFileSync } from 'node:fs';
import { BaronError, parseGapPolicy, parsePolicy, resolveIssuesConfig } from '@baron/core';
import { type Env, buildIssuesPort, buildScmPort, policyPath } from '@baron/providers';
import type { McpPorts } from './tools.js';

/**
 * Load the committed policy and build the live ports it binds. The issues and scm ports are
 * independent (a policy may bind either or both); a missing policy is a server-lifecycle failure
 * (POLICY_NOT_FOUND) and so is a policy that binds neither port. Credentials come from `env`, never
 * from the committed policy.
 */
export function loadPorts(root: string, env: Env): McpPorts {
  const path = policyPath(root);
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  if (raw === undefined) {
    throw new BaronError(
      `No policy found at ${path}. Run \`baron init\` first.`,
      'POLICY_NOT_FOUND',
    );
  }

  const policy = parsePolicy(JSON.parse(raw));
  const ports: {
    issues?: ReturnType<typeof buildIssuesPort>;
    scm?: ReturnType<typeof buildScmPort>;
  } = {};

  if (policy.providers.issues !== undefined) {
    ports.issues = buildIssuesPort(resolveIssuesConfig(policy), env);
  }

  const scmProvider = policy.providers.scm;
  if (scmProvider !== undefined) {
    const gapPolicy = parseGapPolicy(policy.gapPolicy?.[scmProvider] ?? {});
    ports.scm = buildScmPort(scmProvider, env, gapPolicy);
  }

  if (ports.issues === undefined && ports.scm === undefined) {
    throw new BaronError(
      `Policy at ${path} binds neither an issues nor an scm provider; nothing to serve.`,
      'NO_PORTS',
    );
  }
  return ports;
}
