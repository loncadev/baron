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
    expect(names).toEqual(
      expect.arrayContaining(['task-new', 'task-start', 'task-finish', 'ship']),
    );
    const taskNew = summaries.find((s) => s.name === 'task-new');
    expect(taskNew?.inputs.map((i) => i.name)).toContain('title');
    const taskStart = summaries.find((s) => s.name === 'task-start');
    expect(taskStart?.inputs.map((i) => i.name)).toContain('issueId');
  });

  it('runs a built-in recipe by name with pre-supplied inputs (deterministic, no prompts)', async () => {
    const service = createRecipeService(ports(), ROOT);
    // task-new creates; task-start then works on the EXISTING item — the reference split.
    const created = await service.run('task-new', { title: 'Wire it', typeRole: 'task' });
    const issueId = (created.issue as { id: string }).id;

    const context = await service.run('task-start', { issueId });
    const issue = context.issue as { id: string; role?: string; branchName?: string };
    expect(issue.id).toBe(issueId);
    expect(issue.role).toBe('in_progress');
    // The branch is the core-derived canonical name, never an invented one.
    const branch = context.branch as { name: string };
    expect(branch.name).toBe(issue.branchName);
    expect(branch.name).toContain(`/${issueId}-wire-it`);
  });

  it('errors with the missing input names when a required input is absent', async () => {
    await expect(createRecipeService(ports(), ROOT).run('task-start', {})).rejects.toThrow(
      /issueId/,
    );
  });

  it('errors on an unknown recipe name', async () => {
    await expect(createRecipeService(ports(), ROOT).run('nope', {})).rejects.toThrow(
      /Unknown recipe/,
    );
  });
});
