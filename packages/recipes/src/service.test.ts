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
      expect.arrayContaining(['task-new', 'task-start', 'task-finish', 'task-land', 'ship']),
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
    const issueId = (created.context.issue as { id: string }).id;

    const { context, notes } = await service.run('task-start', { issueId });
    const issue = context.issue as { id: string; role?: string; branchName?: string };
    expect(issue.id).toBe(issueId);
    expect(issue.role).toBe('in_progress');
    // The branch is the core-derived canonical name, never an invented one.
    const branch = context.branch as { name: string };
    expect(branch.name).toBe(issue.branchName);
    expect(branch.name).toContain(`/${issueId}-wire-it`);
    // A recipe's own account of what it did must survive the service, whose asker prints nowhere.
    expect(notes.some((n) => n.includes('in progress'))).toBe(true);
  });

  // The service's asker discards notes by design (nobody is at a terminal), which silently threw
  // away task-land's "could not verify the checks" warning on the one path every skill uses.
  it('returns a recipe’s messages even though its asker prints nowhere', async () => {
    const service = createRecipeService(ports(), ROOT);
    const created = await service.run('task-new', { title: 'Talk to me', typeRole: 'task' });
    expect(created.notes.length).toBeGreaterThan(0);
    expect(created.notes.every((n) => typeof n === 'string' && n.length > 0)).toBe(true);
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

describe('task-land and an explicit rejection', () => {
  it('refuses before it mutates anything', async () => {
    // The gate ran on checks alone and never looked at the review, so a pull request a reviewer had
    // explicitly rejected merged exactly as readily as an approved one. Found dogfooding on a real
    // Azure project, where the review decision is the only signal Baron can actually read.
    const scm = defineGithubScmAdapter(
      createMemoryScmTransport({ reviewDecision: 'changes_requested' }),
    );
    const service = createRecipeService({ ...ports(), scm }, ROOT);

    const created = await service.run('task-new', { title: 'Rejected work', typeRole: 'task' });
    const issueId = (created.context.issue as { id: string }).id;
    const started = await service.run('task-start', { issueId });
    const branch = (started.context.branch as { name: string }).name;
    const finished = await service.run('task-finish', {
      issueId,
      branch,
      title: 'Rejected work',
      body: '',
      relation: 'closes',
      autoComplete: 'no',
    });
    const prId = (finished.context.pr as { id: string }).id;

    await expect(service.run('task-land', { issueId })).rejects.toThrow(/changes requested/i);
    // The point of a gate is where it sits: the PR must still be open and still a draft, because
    // task-land undrafts before it merges and neither may have happened.
    const after = await scm.prStatus(prId);
    expect(after.state).toBe('open');
  });
});

describe('task-sync-report', () => {
  it('finds the card whose PR merged, and leaves the honest one alone', async () => {
    // The drift Baron exists to catch: most trackers cannot advance an item when its PR merges, so
    // the card rots in the wrong state. It lived as prose in a skill until the grammar could sweep.
    const scmTransport = createMemoryScmTransport();
    const scm = defineGithubScmAdapter(scmTransport);
    const service = createRecipeService({ ...ports(), scm }, ROOT);

    const drifted = await service.run('task-new', { title: 'Merged already', typeRole: 'task' });
    const driftedId = (drifted.context.issue as { id: string }).id;
    const started = await service.run('task-start', { issueId: driftedId });
    const branch = (started.context.branch as { name: string }).name;
    const finished = await service.run('task-finish', {
      issueId: driftedId,
      branch,
      title: 'Merged already',
      body: '',
      relation: 'closes',
      autoComplete: 'no',
    });
    await scm.mergePr((finished.context.pr as { id: string }).id);

    // A second item in progress whose PR is still open must NOT be reported.
    const honest = await service.run('task-new', { title: 'Still working', typeRole: 'task' });
    const honestId = (honest.context.issue as { id: string }).id;
    const honestStart = await service.run('task-start', { issueId: honestId });
    await service.run('task-finish', {
      issueId: honestId,
      branch: (honestStart.context.branch as { name: string }).name,
      title: 'Still working',
      body: '',
      relation: 'closes',
      autoComplete: 'no',
    });

    const { context, notes } = await service.run('task-sync-report', { scope: 'all' });
    const merged = context.mergedButOpen as string[];
    expect(merged.length, 'the honest item was swept up with the drifted one').toBe(1);
    expect(notes.join('\n')).toContain('Merged but still in progress');
  });

  it('finds the card that is still in review after its PR merged', async () => {
    // The Jira aftermath: task-land merges, the provider does not close on merge, and the card sits
    // in review. The sweep only ever asked in-review items "is there NO pull request?", so the first
    // live Jira run landed here and was told nothing had drifted.
    const scmTransport = createMemoryScmTransport();
    const scm = defineGithubScmAdapter(scmTransport);
    const service = createRecipeService({ ...ports(), scm }, ROOT);

    const landed = await service.run('task-new', {
      title: 'Landed, still in review',
      typeRole: 'task',
    });
    const landedId = (landed.context.issue as { id: string }).id;
    const started = await service.run('task-start', { issueId: landedId });
    const branch = (started.context.branch as { name: string }).name;
    const finished = await service.run('task-finish', {
      issueId: landedId,
      branch,
      title: 'Landed, still in review',
      body: '',
      relation: 'closes',
      autoComplete: 'no',
    });
    await service.run('task-move', { issueId: landedId, role: 'in_review' });
    await scm.mergePr((finished.context.pr as { id: string }).id);

    // An item genuinely in review, PR open, must not be reported under either review class.
    const reviewing = await service.run('task-new', { title: 'Under review', typeRole: 'task' });
    const reviewingId = (reviewing.context.issue as { id: string }).id;
    const reviewingStart = await service.run('task-start', { issueId: reviewingId });
    await service.run('task-finish', {
      issueId: reviewingId,
      branch: (reviewingStart.context.branch as { name: string }).name,
      title: 'Under review',
      body: '',
      relation: 'closes',
      autoComplete: 'no',
    });
    await service.run('task-move', { issueId: reviewingId, role: 'in_review' });

    const { context, notes } = await service.run('task-sync-report', { scope: 'all' });
    expect(context.mergedButInReview).toEqual([(landed.context.issue as { key: string }).key]);
    expect(context.reviewWithoutPr).toEqual([]);
    expect(context.mergedButOpen).toEqual([]);
    expect(notes.join('\n')).toContain('Merged but still in review');
  });

  it('says so plainly when nothing has drifted', async () => {
    const service = createRecipeService(
      { ...ports(), scm: defineGithubScmAdapter(createMemoryScmTransport()) },
      ROOT,
    );
    const { context, notes } = await service.run('task-sync-report', { scope: 'all' });
    // An empty array, not an absent key: a report that cannot say "0" interpolates to nothing.
    expect(context.mergedButOpen).toEqual([]);
    expect(context.mergedButInReview).toEqual([]);
    expect(notes.join('\n')).toContain('Nothing merged is still in progress');
    expect(notes.join('\n')).toContain('Nothing merged is still in review');
  });
});

describe('task-reconcile', () => {
  it('refuses on an item the provider has not closed', async () => {
    // The difference this guards: `reconcile` FOLLOWS the provider, `transition` commands it. Running
    // it on an item the provider never closed would clear a label on the strength of nothing.
    const service = createRecipeService(ports(), ROOT);
    const created = await service.run('task-new', { title: 'Still open', typeRole: 'task' });
    const issueId = (created.context.issue as { id: string }).id;
    await expect(service.run('task-reconcile', { issueId })).rejects.toThrow(
      /there is no provider/,
    );
  });
});
