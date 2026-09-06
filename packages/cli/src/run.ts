import { BaronError, parsePolicyJson } from '@lonca/baron-core';
import { createLocalKnowledgeLoop } from '@lonca/baron-knowledge-loop';
import {
  type Env,
  buildPorts,
  credentialsPath,
  knowledgeDir,
  upsertCredentials,
} from '@lonca/baron-providers';
import {
  type RecipeAsker,
  type RecipeContext,
  type RunRecipeResult,
  loadRecipe,
  resolveRecipeByName,
  runRecipe,
} from '@lonca/baron-recipes';
import { policyPath } from './paths.js';
import type { FileSystem } from './ports.js';

export interface RunRecipeFileOptions {
  readonly root: string;
  /** A built-in or project recipe NAME, or a path to a recipe YAML file. */
  readonly recipePath: string;
  readonly fs: FileSystem;
  readonly asker: RecipeAsker;
  readonly env: Env;
  /** Pre-seed recipe context (skips the matching `ask` steps). */
  readonly inputs?: RecipeContext;
}

/**
 * A `--recipe` value that names a file rather than a recipe: it has a directory separator or a YAML
 * extension. Deciding up front, rather than trying a file read and falling back, is what lets each
 * failure say the right thing — a mistyped path should not be reported as an unknown recipe name.
 */
function looksLikePath(value: string): boolean {
  return /[/\\]/.test(value) || value.endsWith('.yaml') || value.endsWith('.yml');
}

function resolveRecipeArgument(options: RunRecipeFileOptions) {
  if (!looksLikePath(options.recipePath)) {
    return resolveRecipeByName(options.recipePath, options.root);
  }
  const raw = options.fs.read(options.recipePath);
  if (raw === undefined) {
    throw new BaronError(`No recipe found at ${options.recipePath}.`, 'RECIPE_NOT_FOUND');
  }
  return loadRecipe(raw);
}

/**
 * `baron run`: load the committed policy, build its live ports, resolve a recipe, and execute it.
 * The recipe carries the workflow opinion; this just wires the policy's ports + the asker to the
 * engine. Credentials come from `env`, never from the policy.
 */
export async function runRecipeFile(options: RunRecipeFileOptions): Promise<RunRecipeResult> {
  const policyRaw = options.fs.read(policyPath(options.root));
  if (policyRaw === undefined) {
    throw new BaronError(
      `No policy found at ${policyPath(options.root)}. Run \`baron init\` first.`,
      'POLICY_NOT_FOUND',
    );
  }
  const ports = {
    ...buildPorts(parsePolicyJson(policyRaw), options.env, undefined, {
      // Through the CLI's own file system, so a test sees the write and a rotated token lands in
      // the same credentials file the recipe's env was read from.
      persistCredentials: (patch) => {
        const path = credentialsPath(options.root);
        options.fs.write(path, upsertCredentials(options.fs.read(path) ?? '', patch));
      },
    }),
    knowledge: createLocalKnowledgeLoop(knowledgeDir(options.root)),
  };

  return runRecipe(resolveRecipeArgument(options), {
    ports,
    asker: options.asker,
    ...(options.inputs !== undefined ? { inputs: options.inputs } : {}),
  });
}
