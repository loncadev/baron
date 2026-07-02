import {
  defineGithubIssuesAdapter,
  defineGithubScmAdapter,
  exampleGithubRoleMap,
  exampleGithubTypeMap,
  recommendedGithubGapPolicy,
} from '@lonca/baron-adapter-github';
import { createMemoryScmTransport, createMemoryTransport } from '@lonca/baron-conformance';
import { describe, expect, it } from 'vitest';
import type { RecipePorts } from './engine.js';
import { createRecipeService } from './service.js';

function ports(): RecipePorts {
  return {
    issues: defineGithubIssuesAdapter(
      {
        roleMap: exampleGithubRoleMap,
        typeMap: exampleGithubTypeMap,
        gapPolicy: recommendedGithubGapPolicy,
      },
      createMemoryTransport({
        stateKey: exampleGithubRoleMap.stateKey,
        defaultDiscriminator: 'open',
      }),
    ),
    scm: defineGithubScmAdapter(createMemoryScmTransport()),
  };
}

// A root with no .baron/recipes — only the built-ins are available.
const ROOT = 'baron-test-no-project-recipes';

describe('RecipeService', () => {
  it('lists the built-in recipes with their declared inputs', () => {
    const summaries = createRecipeService(ports(), ROOT).list();
    const names = summaries.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['task-start', 'task-finish', 'ship']));
    const taskStart = summaries.find((s) => s.name === 'task-start');
    expect(taskStart?.inputs.map((i) => i.name)).toContain('title');
  });

  it('runs a built-in recipe by name with pre-supplied inputs (deterministic, no prompts)', async () => {
    const context = await createRecipeService(ports(), ROOT).run('task-start', {
      title: 'Wire it',
    });
    expect((context.issue as { title: string; role?: string }).title).toBe('Wire it');
    expect((context.issue as { role?: string }).role).toBe('in_progress');
    expect((context.branch as { name: string }).name).toContain('feature/');
  });

  it('errors with the missing input names when a required input is absent', async () => {
    await expect(createRecipeService(ports(), ROOT).run('task-start', {})).rejects.toThrow(/title/);
  });

  it('errors on an unknown recipe name', async () => {
    await expect(createRecipeService(ports(), ROOT).run('nope', {})).rejects.toThrow(
      /Unknown recipe/,
    );
  });
});
