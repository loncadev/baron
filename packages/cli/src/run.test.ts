import { BaronError, type BaronPolicyFile, serializePolicy } from '@lonca/baron-core';
import { BUILTIN_RECIPE_NAMES } from '@lonca/baron-recipes';
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

  it('resolves a built-in by name, with no file anywhere', async () => {
    // The README's quick start promises "no clone, no build" and then told the reader to run
    // `--recipe <path-to>/task-start.yaml`. There was no path to give: the CLI read --recipe as a
    // literal file and only the MCP server could resolve a name, so the third of three quick-start
    // steps was a dead end for anyone who followed the first two.
    const fs = memoryFileSystem({ [policyPath(ROOT)]: serializePolicy(policy) });
    const asker = scriptedAsker();
    // Asserts on the CODE, not the message. Written against the message first, this passed with the
    // resolution deleted — "No recipe found at task-start." does not contain the string
    // RECIPE_NOT_FOUND, so the test protected nothing while looking like it did.
    for (const name of BUILTIN_RECIPE_NAMES) {
      const failure = await runRecipeFile({ root: ROOT, recipePath: name, fs, asker, env }).then(
        () => undefined,
        (error: unknown) => error,
      );
      const code = failure instanceof BaronError ? failure.code : undefined;
      // What the recipe does once resolved — prompt, call a provider, fail on a fake token — is not
      // this test's business. Only that it was never "I cannot find that recipe".
      expect(code, `built-in '${name}' must resolve by name`).not.toBe('RECIPE_NOT_FOUND');
    }
  });

  it('reports a mistyped path as a missing file, not as an unknown recipe', async () => {
    // Which is why the two are told apart before either is attempted rather than by falling back:
    // "Unknown recipe './recipes/task-strat.yaml'. Built-ins: ..." helps nobody find a typo.
    const fs = memoryFileSystem({ [policyPath(ROOT)]: serializePolicy(policy) });
    await expect(
      runRecipeFile({
        root: ROOT,
        recipePath: './nope/task-x.yaml',
        fs,
        asker: scriptedAsker(),
        env,
      }),
    ).rejects.toThrow(/No recipe found at/);
  });

  it('lists the built-ins when a bare name matches nothing', async () => {
    const fs = memoryFileSystem({ [policyPath(ROOT)]: serializePolicy(policy) });
    await expect(
      runRecipeFile({ root: ROOT, recipePath: 'task-shuffle', fs, asker: scriptedAsker(), env }),
    ).rejects.toThrow(/Unknown recipe 'task-shuffle'\. Built-ins: /);
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
