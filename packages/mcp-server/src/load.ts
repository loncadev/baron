import { existsSync, readFileSync } from 'node:fs';
import { BaronError, parsePolicyJson } from '@baron/core';
import { createLocalKnowledgeLoop } from '@baron/knowledge-loop';
import { type Env, buildPorts, knowledgeDir, policyPath } from '@baron/providers';
import type { McpPorts } from './tools.js';

/**
 * Load the committed policy and build the ports it serves: the issues/scm ports it binds (either or
 * both) plus the always-available local knowledge loop (markdown store under `.baron/knowledge`). A
 * missing policy is a server-lifecycle failure (POLICY_NOT_FOUND). Credentials come from `env`,
 * never from the committed policy.
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

  return {
    ...buildPorts(parsePolicyJson(raw), env),
    knowledge: createLocalKnowledgeLoop(knowledgeDir(root)),
  };
}
