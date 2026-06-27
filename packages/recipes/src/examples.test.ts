import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadRecipe } from './recipe.js';

const recipesDir = fileURLToPath(new URL('../recipes/', import.meta.url));
const files = readdirSync(recipesDir).filter((name) => name.endsWith('.yaml'));

describe('shipped example recipes', () => {
  it('ships at least one example recipe', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s parses and validates', (file) => {
    const recipe = loadRecipe(readFileSync(`${recipesDir}${file}`, 'utf8'));
    expect(recipe.name).toBeTruthy();
    expect(recipe.steps.length).toBeGreaterThan(0);
  });
});
