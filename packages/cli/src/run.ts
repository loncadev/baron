import { BaronError, parsePolicyJson } from '@lonca/baron-core';
import { createLocalKnowledgeLoop } from '@lonca/baron-knowledge-loop';
import { type Env, buildPorts, knowledgeDir } from '@lonca/baron-providers';
import {
  type RecipeAsker,
  type RecipeContext,
  type RunRecipeResult,
  loadRecipe,
  runRecipe,
} from '@lonca/baron-recipes';
import { policyPath } from './paths.js';
import type { FileSystem } from './ports.js';

export interface RunRecipeFileOptions {
  readonly root: string;
  /** Path to the recipe YAML file. */
  readonly recipePath: string;
  readonly fs: FileSystem;
  readonly asker: RecipeAsker;
  readonly env: Env;
  /** Pre-seed recipe context (skips the matching `ask` steps). */
  readonly inputs?: RecipeContext;
}

/**
 * `baron run`: load the committed policy, build its live ports, load a recipe file, and execute it.
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
    ...buildPorts(parsePolicyJson(policyRaw), options.env),
    knowledge: createLocalKnowledgeLoop(knowledgeDir(options.root)),
  };

  const recipeRaw = options.fs.read(options.recipePath);
  if (recipeRaw === undefined) {
    throw new BaronError(`No recipe found at ${options.recipePath}.`, 'RECIPE_NOT_FOUND');
  }

  return runRecipe(loadRecipe(recipeRaw), {
    ports,
    asker: options.asker,
    ...(options.inputs !== undefined ? { inputs: options.inputs } : {}),
  });
}
