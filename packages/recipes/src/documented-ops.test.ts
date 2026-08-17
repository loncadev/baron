import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RECIPE_OPS } from './recipe.js';

const RECIPES_DOC = fileURLToPath(new URL('../../../docs/recipes.md', import.meta.url));

/** Ops named in the first column of the op-reference table. */
function documentedOps(): string[] {
  const doc = readFileSync(RECIPES_DOC, 'utf8');
  return [...doc.matchAll(/^\|\s*`([a-z]+\.[a-z.\-]+)`\s*\|/gm)].map((m) => m[1] as string);
}

describe('the op reference in docs/recipes.md', () => {
  it('lists exactly the ops a recipe may use', () => {
    // The table is presented as the complete set a `do:` step accepts, and omitted eight — five of
    // them used by the recipes Baron itself ships. A reader writing a project recipe against it
    // would conclude that blocking, classifying a move, and merging a PR were capabilities Baron
    // does not have, when the built-ins next to them use exactly those.
    const documented = documentedOps();
    // Guards the guard: a changed table format must not make this pass by matching nothing.
    expect(documented.length).toBeGreaterThan(0);
    expect([...documented].sort()).toEqual([...Object.values(RECIPE_OPS)].sort());
  });
});
