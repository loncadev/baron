import { existsSync, readFileSync } from 'node:fs';
import { BaronError, parsePolicy } from '@baron/core';
import { type Env, buildPorts, policyPath } from '@baron/providers';
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

  const ports = buildPorts(parsePolicy(JSON.parse(raw)), env);
  if (ports.issues === undefined && ports.scm === undefined) {
    throw new BaronError(
      `Policy at ${path} binds neither an issues nor an scm provider; nothing to serve.`,
      'NO_PORTS',
    );
  }
  return ports;
}
