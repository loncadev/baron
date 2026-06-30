import { existsSync, readFileSync } from 'node:fs';
import { BaronError, parsePolicyJson } from '@baron/core';
import { createLocalKnowledgeLoop } from '@baron/knowledge-loop';
import {
  type Env,
  buildPorts,
  credentialsPath,
  executeNativeRequest,
  knowledgeDir,
  mergeCredentials,
  policyPath,
} from '@baron/providers';
import { createRecipeService } from '@baron/recipes';
import type { McpPorts, NativeAccess } from './tools.js';

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
  const policy = parsePolicyJson(raw);
  // The escape hatch reaches only providers this policy actually binds — never an arbitrary one.
  const boundProviders = new Set(
    Object.values(policy.providers).filter((p): p is string => typeof p === 'string'),
  );
  const nativeAccess: NativeAccess = (provider, request) => {
    if (!boundProviders.has(provider)) {
      throw new BaronError(
        `Provider '${provider}' is not bound in this policy; the escape hatch only reaches bound providers.`,
        'NATIVE_UNSUPPORTED',
      );
    }
    return executeNativeRequest(provider, effectiveEnv, request);
  };
  const bound = buildPorts(policy, effectiveEnv);
  const knowledge = createLocalKnowledgeLoop(knowledgeDir(root));
  // The recipe runner drives the SAME bound ports the agent uses, deterministically (the engine
  // enforces order/rules); built-ins resolve by name, project recipes from <root>/.baron/recipes.
  const recipes = createRecipeService({ ...bound, knowledge }, root);
  return { ...bound, knowledge, nativeAccess, recipes };
}
