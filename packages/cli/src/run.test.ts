import { BaronError, type BaronPolicyFile, serializePolicy } from '@lonca/baron-core';
import { describe, expect, it } from 'vitest';
import { memoryFileSystem, scriptedAsker } from './fakes.js';
import { policyPath } from './paths.js';
import { runRecipeFile } from './run.js';

const ROOT = '/repo';
const RECIPE = `${ROOT}/recipe.yaml`;
const env = { GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_TOKEN: 't' };

const policy: BaronPolicyFile = {
  version: 1,
  providers: { issues: 'github' },
  roleMap: { github: { stateKey: 'label', states: { done: { state: 'closed', label: 'done' } } } },
  typeMap: { github: { task: 'issue' } },
};

function seeded(recipe: string): ReturnType<typeof memoryFileSystem> {
  return memoryFileSystem({ [policyPath(ROOT)]: serializePolicy(policy), [RECIPE]: recipe });
}

describe('runRecipeFile', () => {
  it('builds the policy ports and runs a recipe (a message-only recipe needs no network)', async () => {
    const fs = seeded('name: hi\nsteps:\n  - message: "all done"');
    const asker = scriptedAsker();
    await runRecipeFile({ root: ROOT, recipePath: RECIPE, fs, asker, env });
    expect(asker.notes).toContain('all done');
  });

  it('throws POLICY_NOT_FOUND when there is no policy', async () => {
    const fs = memoryFileSystem({ [RECIPE]: 'name: hi\nsteps:\n  - message: "x"' });
    await expect(
      runRecipeFile({ root: ROOT, recipePath: RECIPE, fs, asker: scriptedAsker(), env }),
    ).rejects.toBeInstanceOf(BaronError);
  });

  it('throws a coded POLICY_PARSE error on malformed policy JSON', async () => {
    const fs = memoryFileSystem({
      [policyPath(ROOT)]: '{ not valid json',
      [RECIPE]: 'name: hi\nsteps:\n  - message: "x"',
    });
    await expect(
      runRecipeFile({ root: ROOT, recipePath: RECIPE, fs, asker: scriptedAsker(), env }),
    ).rejects.toThrow(/valid JSON/);
  });

  it('throws RECIPE_NOT_FOUND when the recipe file is missing', async () => {
    const fs = memoryFileSystem({ [policyPath(ROOT)]: serializePolicy(policy) });
    await expect(
      runRecipeFile({ root: ROOT, recipePath: RECIPE, fs, asker: scriptedAsker(), env }),
    ).rejects.toThrow(/RECIPE_NOT_FOUND|No recipe/);
  });
});
