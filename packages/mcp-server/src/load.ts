import { existsSync, readFileSync } from 'node:fs';
import { BaronError, parsePolicyJson } from '@lonca/baron-core';
import { createLocalKnowledgeLoop } from '@lonca/baron-knowledge-loop';
import {
  type Env,
  buildPorts,
  createCredentialsFileHooks,
  credentialsPath,
  executeNativeRequest,
  knowledgeDir,
  mergeCredentials,
  policyPath,
} from '@lonca/baron-providers';
import { createFileRunJournal, createRecipeService } from '@lonca/baron-recipes';
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
  // Rotated tokens go back into this project's credentials file, or a browser sign-in whose
  // refresh token rotates on use would be good for exactly one server process.
  const bound = buildPorts(policy, effectiveEnv, undefined, createCredentialsFileHooks(root));
  const knowledge = createLocalKnowledgeLoop(knowledgeDir(root));
  // The recipe runner drives the SAME bound ports the agent uses, deterministically (the engine
  // enforces order/rules); built-ins resolve by name, project recipes from <root>/.baron/recipes.
  // Journaled under <root>/.baron/runs so a run that stops halfway can be resumed by a later call
  // — or a later server process.
  const recipes = createRecipeService({ ...bound, knowledge }, root, {
    journal: createFileRunJournal(root),
  });
  return {
    ...bound,
    knowledge,
    nativeAccess,
    recipes,
    // Absent in policy means `open` — dispatch applies the default, so nothing is asserted here.
    ...(policy.mutations !== undefined ? { mutationChannel: policy.mutations.channel } : {}),
    ...(policy.tools !== undefined ? { toolsPublish: policy.tools.publish } : {}),
  };
}
