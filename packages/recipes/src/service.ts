import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { BaronError } from '@lonca/baron-core';
import type { RecipeAsker } from './ask.js';
import { BUILTIN_RECIPE_NAMES, isBuiltinRecipe, loadBuiltinRecipe } from './builtins.js';
import { type RecipePorts, runRecipe } from './engine.js';
import type { RecipeContext } from './interpolate.js';
import { type Recipe, type RecipeInput, loadRecipe, recipeInputs } from './recipe.js';

export interface RecipeSummary {
  readonly name: string;
  readonly description?: string;
  readonly inputs: RecipeInput[];
}

/**
 * Runs Baron's declarative recipes deterministically (the engine enforces order/rules, not the agent),
 * with inputs supplied upfront — so a workflow is one atomic, rule-enforced call. Resolves built-in
 * recipes by name plus any project recipes under `<root>/.baron/recipes/*.yaml`.
 */
export interface RecipeService {
  list(): RecipeSummary[];
  run(name: string, inputs: Record<string, unknown>): Promise<RecipeContext>;
}

const RECIPE_DIR_REL = '.baron/recipes';
const YAML_EXT = '.yaml';

/**
 * Non-interactive asker for server-side runs: required inputs are pre-validated in {@link
 * RecipeService.run}, so this only ever fires for an OPTIONAL text ask (→ undefined). Anything else is
 * a missing input and throws — a recipe never silently prompts in a headless context.
 */
const nonInteractiveAsker: RecipeAsker = {
  async text(_message, optional) {
    if (optional) return undefined;
    throw new BaronError('Recipe needs an input that was not provided.', 'RECIPE_INPUT_MISSING');
  },
  async confirm() {
    throw new BaronError(
      'Recipe needs a confirmation that was not provided.',
      'RECIPE_INPUT_MISSING',
    );
  },
  async choice() {
    throw new BaronError('Recipe needs a choice that was not provided.', 'RECIPE_INPUT_MISSING');
  },
  note() {},
};

function projectRecipePath(root: string, name: string): string {
  return `${root}/${RECIPE_DIR_REL}/${name}${YAML_EXT}`;
}

function resolveRecipe(name: string, root: string): Recipe {
  if (isBuiltinRecipe(name)) return loadBuiltinRecipe(name);
  const path = projectRecipePath(root, name);
  if (!existsSync(path)) {
    throw new BaronError(
      `Unknown recipe '${name}'. Built-ins: ${BUILTIN_RECIPE_NAMES.join(', ')}; or add ${RECIPE_DIR_REL}/${name}${YAML_EXT}.`,
      'RECIPE_NOT_FOUND',
    );
  }
  return loadRecipe(readFileSync(path, 'utf8'));
}

function summarize(name: string, recipe: Recipe): RecipeSummary {
  return {
    name,
    ...(recipe.description !== undefined ? { description: recipe.description } : {}),
    inputs: recipeInputs(recipe),
  };
}

export function createRecipeService(ports: RecipePorts, root: string): RecipeService {
  return {
    list() {
      const builtins = BUILTIN_RECIPE_NAMES.map((name) => summarize(name, loadBuiltinRecipe(name)));
      const dir = `${root}/${RECIPE_DIR_REL}`;
      const project = !existsSync(dir)
        ? []
        : readdirSync(dir)
            .filter((f) => f.endsWith(YAML_EXT))
            .map((f) => f.slice(0, -YAML_EXT.length))
            .filter((name) => !isBuiltinRecipe(name))
            .map((name) =>
              summarize(name, loadRecipe(readFileSync(projectRecipePath(root, name), 'utf8'))),
            );
      return [...builtins, ...project];
    },

    async run(name, inputs) {
      const recipe = resolveRecipe(name, root);
      // Pre-validate every non-optional ask is supplied — clearer than failing partway through a run.
      const missing = recipeInputs(recipe)
        .filter((i) => !(i.type === 'text' && i.optional))
        .filter((i) => inputs[i.name] === undefined);
      if (missing.length > 0) {
        throw new BaronError(
          `Recipe '${name}' needs input(s): ${missing.map((i) => `${i.name} — ${i.message}`).join('; ')}.`,
          'RECIPE_INPUT_MISSING',
        );
      }
      const result = await runRecipe(recipe, { ports, asker: nonInteractiveAsker, inputs });
      return result.context;
    },
  };
}
