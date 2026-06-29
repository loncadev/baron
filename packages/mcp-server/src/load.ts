import { existsSync, readFileSync } from 'node:fs';
import { BaronError, parsePolicyJson } from '@baron/core';
import { createLocalKnowledgeLoop } from '@baron/knowledge-loop';
import {
  type Env,
  buildPorts,
  credentialsPath,
  knowledgeDir,
  mergeCredentials,
  policyPath,
} from '@baron/providers';
import type { McpPorts } from './tools.js';

function readIfPresent(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/**
 * Load the committed policy and build the ports it serves: the issues/scm ports it binds (either or
 * both) plus the always-available local knowledge loop (markdown store under `.baron/knowledge`). A
 * missing policy is a server-lifecycle failure (POLICY_NOT_FOUND). Credentials come from `env`
 * (overlaid by a gitignored `.baron/credentials` file when present), never from the policy.
 */
export function loadPorts(root: string, env: Env): McpPorts {
  const path = policyPath(root);
  const raw = readIfPresent(path);
  if (raw === undefined) {
    throw new BaronError(
      `No policy found at ${path}. Run \`baron init\` first.`,
      'POLICY_NOT_FOUND',
    );
  }

  const effectiveEnv = mergeCredentials(env, readIfPresent(credentialsPath(root)));
  return {
    ...buildPorts(parsePolicyJson(raw), effectiveEnv),
    knowledge: createLocalKnowledgeLoop(knowledgeDir(root)),
  };
}
