import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUILTIN_RECIPE_NAMES, isBuiltinRecipe, loadBuiltinRecipe } from './builtins.js';

const RECIPES_DIR = fileURLToPath(new URL('../recipes/', import.meta.url));
// Reaches out of the package on purpose: the invariant being protected spans the repository, and
// there is no lower place that can see both the registry and the skills that depend on it.
const SKILLS_DIR = fileURLToPath(new URL('../../../plugins/claude-code/skills/', import.meta.url));

const shippedRecipeFiles = () =>
  readdirSync(RECIPES_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.replace(/\.yaml$/, ''));

/**
 * Recipe names the shipped Claude Code skills tell an agent to run. Matched on the `baron_recipe_run`
 * payload shape (`"name": "x", "inputs":`) rather than any `"name"` key, so an unrelated JSON field
 * in a skill cannot be mistaken for a recipe.
 */
function recipeNamesInvokedBySkills(): Array<{ skill: string; recipe: string }> {
  const invoked: Array<{ skill: string; recipe: string }> = [];
  for (const skill of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!skill.isDirectory()) continue;
    let body: string;
    try {
      body = readFileSync(`${SKILLS_DIR}${skill.name}/SKILL.md`, 'utf8');
    } catch {
      continue;
    }
    for (const match of body.matchAll(/"name":\s*"([a-z-]+)"\s*,\s*"inputs"/g)) {
      invoked.push({ skill: skill.name, recipe: match[1] as string });
    }
  }
  return invoked;
}

describe('the built-in recipe registry', () => {
  it('registers every recipe that ships in the package', () => {
    // task-move shipped in 0.32.0 as a YAML file and a skill, and was never added here — so the
    // skill failed with RECIPE_NOT_FOUND for every user, and the error's own hint pointed at a file
    // they had no way to obtain. Three lists (the YAML on disk, this registry, the skills that call
    // it) had nothing connecting them; this test is that connection.
    expect([...BUILTIN_RECIPE_NAMES].sort()).toEqual(shippedRecipeFiles().sort());
  });

  it('can actually load each one it claims', () => {
    // Being in the list is not the same as resolving: the file has to be reachable from both src/
    // and dist/, which is the other half of how a built-in goes missing.
    for (const name of BUILTIN_RECIPE_NAMES) {
      expect(loadBuiltinRecipe(name).name).toBe(name);
    }
  });

  it('resolves every recipe name the shipped skills tell an agent to run', () => {
    const invoked = recipeNamesInvokedBySkills();
    // Guards the guard: if the payload shape in the skills changes, this finds nothing and would
    // pass vacuously while protecting no one.
    expect(invoked.length).toBeGreaterThan(0);
    const unresolvable = invoked.filter(({ recipe }) => !isBuiltinRecipe(recipe));
    expect(unresolvable).toEqual([]);
  });
});

describe('the built-in recipes a reader is told about', () => {
  it('are the ones that actually ship', () => {
    // The reverse of the tie above: that one catches a skill naming a recipe that does not exist,
    // and this one catches a recipe nobody is told exists. Adding a built-in and forgetting the docs
    // passed every check until now — the same two-hand-maintained-lists defect, one direction shy.
    const docs = readFileSync(
      fileURLToPath(new URL('../../../docs/recipes.md', import.meta.url)),
      'utf8',
    );
    const undocumented = BUILTIN_RECIPE_NAMES.filter((name) => !docs.includes(`\`${name}\``));
    expect(undocumented).toEqual([]);
  });
});
