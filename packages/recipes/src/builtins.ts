import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Recipe, loadRecipe } from './recipe.js';

// The packaged recipes live next to the compiled module (../recipes/*.yaml relative to both src/ and
// dist/), and ship via the package's `files` — so they resolve the same in dev (tsx) and when published.
const RECIPES_DIR = fileURLToPath(new URL('../recipes/', import.meta.url));

/** The recipes Baron ships out of the box, runnable by name (no file path). */
export const BUILTIN_RECIPE_NAMES = ['task-start', 'task-finish', 'ship'] as const;
export type BuiltinRecipeName = (typeof BUILTIN_RECIPE_NAMES)[number];

export function isBuiltinRecipe(name: string): name is BuiltinRecipeName {
  return (BUILTIN_RECIPE_NAMES as readonly string[]).includes(name);
}

/** Raw YAML of a built-in recipe (the canonical file — no inlined copy, so it can never drift). */
export function loadBuiltinRecipeText(name: BuiltinRecipeName): string {
  return readFileSync(`${RECIPES_DIR}${name}.yaml`, 'utf8');
}

export function loadBuiltinRecipe(name: BuiltinRecipeName): Recipe {
  return loadRecipe(loadBuiltinRecipeText(name));
}
