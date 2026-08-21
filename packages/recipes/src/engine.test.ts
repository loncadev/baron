import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  defineGithubIssuesAdapter,
  defineGithubScmAdapter,
  exampleGithubRoleMap,
  exampleGithubTypeMap,
  recommendedGithubGapPolicy,
} from '@lonca/baron-adapter-github';
import {
  createMemoryCiTransport,
  createMemoryDeployTransport,
  createMemoryNotifyTransport,
  createMemoryScmTransport,
  createMemoryTransport,
} from '@lonca/baron-conformance';
import {
  BaronError,
  BaseCiAdapter,
  BaseDeployAdapter,
  BaseNotifyAdapter,
  type CheckSummary,
  type IssuesPort,
  type ScmPort,
} from '@lonca/baron-core';
import { KnowledgeLoop, createMemoryKnowledgeStore } from '@lonca/baron-knowledge-loop';
import { describe, expect, it } from 'vitest';
import type { RecipeAsker } from './ask.js';
import { type RecipePorts, runRecipe } from './engine.js';
import { loadRecipe } from './recipe.js';

function issuesPort(): IssuesPort {
  return defineGithubIssuesAdapter(
    {
      roleMap: exampleGithubRoleMap,
      typeMap: exampleGithubTypeMap,
      gapPolicy: recommendedGithubGapPolicy,
    },
    createMemoryTransport({
      stateKey: exampleGithubRoleMap.stateKey,
      defaultDiscriminator: 'open',
    }),
  );
}

function scmPort(): ScmPort {
  return defineGithubScmAdapter(createMemoryScmTransport());
}

function allPorts(): RecipePorts {
  return {
    issues: issuesPort(),
    scm: scmPort(),
    ci: new BaseCiAdapter(
      {
        provider: 'mem',
        ci: {
          canTrigger: true,
          canCancel: true,
          hasStages: false,
          hasApprovalGates: false,
          providesLogs: true,
          hasArtifacts: false,
        },
      },
      { status: { inProgress: 'running' }, result: { succeeded: 'succeeded' } },
      createMemoryCiTransport(),
    ),
    deploy: new BaseDeployAdapter(
      { provider: 'mem', deploy: { environments: true, deployments: true, canTrigger: false } },
      { status: {}, result: {} },
      createMemoryDeployTransport(),
    ),
    notify: new BaseNotifyAdapter(
      { provider: 'mem', notify: { channels: true, threads: true, richText: true } },
      createMemoryNotifyTransport(),
    ),
    knowledge: new KnowledgeLoop(createMemoryKnowledgeStore()),
  };
}

/** A scripted asker: text answers replay from a queue; notes are recorded. */
function scriptedAsker(
  textAnswers: (string | undefined)[] = [],
): RecipeAsker & { notes: string[] } {
  const notes: string[] = [];
  let cursor = 0;
  return {
    notes,
    async text() {
      return textAnswers[cursor++];
    },
    async confirm() {
      return true;
    },
    async choice(_message, choices) {
      return choices[0] ?? '';
    },
    note(message) {
      notes.push(message);
    },
  };
}

const taskStart = `
name: task-start
steps:
  - ask: { as: title, type: text, message: "Title?" }
  - do: issue.create
    as: issue
    with:
      title: \${title}
      typeRole: task
  - do: scm.branch.create
    as: branch
    with:
      name: feature/\${issue.id}
      fromBranch: main
  - do: issue.transition
    as: issue
    with:
      id: \${issue.id}
      role: in_review
  - message: "Opened \${issue.key} on \${branch.name}"
`;

describe('runRecipe', () => {
  it('runs a full task-start recipe across the issues and scm ports', async () => {
    const asker = scriptedAsker(['Wire the thing']);
    const { context } = await runRecipe(loadRecipe(taskStart), { ports: allPorts(), asker });

    const issue = context.issue as { id: string; title: string; role?: string };
    expect(issue.title).toBe('Wire the thing');
    expect(issue.role).toBe('in_review');

    const branch = context.branch as { name: string };
    expect(branch.name).toBe(`feature/${issue.id}`);

    expect(asker.notes.some((n) => n.includes('Opened'))).toBe(true);
  });

  it('require guard STOPS the run with the interpolated message before any later mutation', async () => {
    const recipe = loadRecipe(`
name: guarded
steps:
  - ask: { as: title, type: text, message: "Title?" }
  - do: issue.create
    as: issue
    with: { title: "\${title}", typeRole: task }
  - require:
      equals: ["\${issue.role}", "in_progress"]
      message: "\${issue.key} is not in progress — refuse."
  - do: issue.comment
    with: { id: "\${issue.id}", body: "never reached" }
`);
    await expect(
      runRecipe(recipe, { ports: allPorts(), asker: scriptedAsker(['x']) }),
    ).rejects.toMatchObject({ code: 'RECIPE_REQUIRE', message: expect.stringContaining('#1') });
  });

  it('require guard passes when the condition holds (truthy on a present field)', async () => {
    const recipe = loadRecipe(`
name: guarded-ok
steps:
  - do: issue.create
    as: issue
    with: { title: "guarded ok", typeRole: task }
  - require:
      truthy: "\${issue.branchName}"
      message: "no branch name"
  - message: "branch is \${issue.branchName}"
`);
    const asker = scriptedAsker();
    await runRecipe(recipe, { ports: allPorts(), asker });
    expect(asker.notes.some((n) => n.includes('branch is'))).toBe(true);
  });

  it('when: on a require makes the guard conditional — skipped when the precondition is falsy', async () => {
    const recipe = loadRecipe(`
name: conditional-guard
steps:
  - do: issue.create
    as: issue
    with: { title: "no assignee", typeRole: task }
  - require:
      truthy: "\${takeover}"
      message: "assigned to \${issue.assignee} — pass takeover"
    when:
      truthy: "\${issue.assignee}"
  - message: "started"
`);
    // A freshly created issue has no assignee → the guard's when is falsy → it must NOT fire, even
    // though takeover was not passed.
    const asker = scriptedAsker();
    await runRecipe(recipe, { ports: allPorts(), asker });
    expect(asker.notes.some((n) => n === 'started')).toBe(true);
  });

  it('when: on a require still STOPS when the precondition holds and the guard fails', async () => {
    const recipe = loadRecipe(`
name: conditional-guard-fires
steps:
  - require:
      truthy: "\${takeover}"
      message: "assigned to \${who} — pass takeover"
    when:
      truthy: "\${who}"
`);
    // Precondition holds (who is set) and takeover was not passed → the guard fires and stops.
    await expect(
      runRecipe(recipe, {
        ports: allPorts(),
        asker: scriptedAsker(),
        inputs: { who: 'someone@else.com' },
      }),
    ).rejects.toMatchObject({
      code: 'RECIPE_REQUIRE',
      message: expect.stringContaining('someone'),
    });
  });

  // The task-start ownership guard: start freely when the item is unassigned or already YOURS, stop
  // only when it belongs to someone else. Resuming your own work must never trip it (the v0.9 bug:
  // task-start assigns to @me, so every re-run then looked like a takeover and locked the item).
  const ownershipGuard = `
  - do: issue.whoami
    as: me
  - require:
      equals: ["\${issue.assignee}", "\${me}"]
      message: "assigned to \${issue.assignee}, not you (\${me})"
    when:
      truthy: "\${issue.assignee}"
  - message: "started"
`;

  it('ownership guard: an item assigned to YOU starts (resume stays idempotent)', async () => {
    const recipe = loadRecipe(`
name: own-item
steps:
  - do: issue.create
    as: issue
    with: { title: "mine", typeRole: task }
  - do: issue.assign
    as: issue
    with: { id: "\${issue.id}", assignee: "@me" }
${ownershipGuard}
`);
    const asker = scriptedAsker();
    await runRecipe(recipe, { ports: allPorts(), asker });
    expect(asker.notes.some((n) => n === 'started')).toBe(true);
  });

  it('ownership guard: an item assigned to SOMEONE ELSE stops before any mutation', async () => {
    const recipe = loadRecipe(`
name: other-item
steps:
  - do: issue.create
    as: issue
    with: { title: "theirs", typeRole: task }
  - do: issue.assign
    as: issue
    with: { id: "\${issue.id}", assignee: "someone@else.com" }
${ownershipGuard}
`);
    await expect(
      runRecipe(recipe, { ports: allPorts(), asker: scriptedAsker() }),
    ).rejects.toMatchObject({
      code: 'RECIPE_REQUIRE',
      message: expect.stringContaining('someone@else.com'),
    });
  });

  it('branch.created gates the "branch created" comment — a resume does not repeat it', async () => {
    // task-start comments the branch on the item. On a resume the branch already exists, so the
    // comment must NOT fire again: it would duplicate the line and claim a creation that never
    // happened. Running the same recipe twice must leave exactly one comment.
    const recipe = loadRecipe(`
name: start-with-comment
steps:
  - do: scm.branch.create
    as: branch
    with: { name: "feature/resume-once", fromBranch: "main" }
  - message: "commented: \${branch.name}"
    when:
      truthy: "\${branch.created}"
`);
    const ports = allPorts();
    const asker = scriptedAsker();
    await runRecipe(recipe, { ports, asker });
    await runRecipe(recipe, { ports, asker });
    expect(asker.notes.filter((n) => n.startsWith('commented:'))).toHaveLength(1);
  });

  it('when: skips do/message steps without failing (falsy vs truthy branches)', async () => {
    const recipe = loadRecipe(`
name: branchy
steps:
  - do: scm.pr.find
    as: existing
    with: { sourceBranch: "feature/none" }
  - do: scm.pr.create
    as: pr
    when:
      falsy: "\${existing}"
    with: { title: "PR", sourceBranch: "feature/none" }
  - message: "created \${pr.id}"
    when:
      falsy: "\${existing}"
  - message: "reused \${existing.id}"
    when:
      truthy: "\${existing}"
`);
    const asker = scriptedAsker();
    const { context } = await runRecipe(recipe, { ports: allPorts(), asker });
    expect(context.pr).toBeDefined();
    expect(asker.notes.some((n) => n.startsWith('created'))).toBe(true);
    expect(asker.notes.some((n) => n.startsWith('reused'))).toBe(false);
  });

  it('task-finish is engine-idempotent: a second run reports the existing PR, no duplicate', async () => {
    const ports = allPorts();
    const finish = `
name: finish
steps:
  - do: scm.pr.find
    as: existingPr
    with: { sourceBranch: "feature/once" }
  - message: "PR already open: \${existingPr.url}"
    when:
      truthy: "\${existingPr}"
  - do: scm.pr.create
    as: pr
    when:
      falsy: "\${existingPr}"
    with: { title: "Once", sourceBranch: "feature/once" }
`;
    const first = await runRecipe(loadRecipe(finish), { ports, asker: scriptedAsker() });
    expect(first.context.pr).toBeDefined();
    expect(first.context.existingPr).toBeNull();

    const asker = scriptedAsker();
    const second = await runRecipe(loadRecipe(finish), { ports, asker });
    expect(second.context.pr).toBeUndefined(); // create skipped
    expect((second.context.existingPr as { id: string }).id).toBe(
      (first.context.pr as { id: string }).id,
    );
    expect(asker.notes.some((n) => n.includes('already open'))).toBe(true);
  });

  it('lands a draft PR: undrafts only when it is a draft, then merges', async () => {
    const ports = allPorts();
    const land = `
name: land
steps:
  - do: scm.pr.find
    as: pr
    with: { sourceBranch: "feature/land" }
  - require:
      truthy: "\${pr}"
      message: "no open PR on feature/land"
  - do: scm.pr.ready
    when:
      truthy: "\${pr.draft}"
    with: { pullRequestId: "\${pr.id}" }
  - do: scm.pr.merge
    as: merged
    with: { pullRequestId: "\${pr.id}", strategy: "squash", deleteSourceBranch: "yes" }
`;
    // No PR yet: the guard must STOP rather than merge nothing and report success.
    await expect(
      runRecipe(loadRecipe(land), { ports, asker: scriptedAsker() }),
    ).rejects.toBeInstanceOf(BaronError);

    await ports.scm?.createPullRequest({
      title: 'Land',
      sourceBranch: 'feature/land',
      draft: true,
    });
    const { context } = await runRecipe(loadRecipe(land), { ports, asker: scriptedAsker() });
    expect((context.merged as { sha: string }).sha).toBeTruthy();
    // The PR is gone from the OPEN set — it really merged, it was not just reported as merged.
    expect(await ports.scm?.prForBranch('feature/land')).toBeUndefined();
  });

  it('runs ci / notify / deploy / scm-status ops across the new ports', async () => {
    const recipe = loadRecipe(`
name: single-pane
steps:
  - do: ci.run.trigger
    as: run
    with: { pipelineId: "p1", ref: "main" }
  - do: deploy.deployments
    as: deploys
    with: { limit: 5 }
  - do: notify.send
    as: msg
    with: { text: "ci accepted: \${run.accepted}", channel: "releases" }
  - message: "done"
`);
    const { context } = await runRecipe(recipe, { ports: allPorts(), asker: scriptedAsker() });
    expect((context.run as { accepted: boolean }).accepted).toBe(true);
    expect(Array.isArray(context.deploys)).toBe(true);
    expect((context.msg as { id: string }).id).toBeTruthy();
  });

  it('rejects a non-boolean draft on scm.pr.create (no silent coercion)', async () => {
    const recipe = loadRecipe(`
name: bad-draft
steps:
  - do: scm.pr.create
    with: { title: "t", sourceBranch: "feature/x", draft: "yes" }
`);
    await expect(
      runRecipe(recipe, { ports: allPorts(), asker: scriptedAsker() }),
    ).rejects.toThrow();
  });

  it('skips an ask whose variable is pre-seeded via inputs', async () => {
    // No text answers queued; if the ask were not skipped, title would be undefined and create fails.
    const asker = scriptedAsker([]);
    const { context } = await runRecipe(loadRecipe(taskStart), {
      ports: allPorts(),
      asker,
      inputs: { title: 'Seeded' },
    });
    expect((context.issue as { title: string }).title).toBe('Seeded');
  });

  it('leaves an optional unresolved reference as undefined (not the literal text)', async () => {
    const recipe = loadRecipe(`
name: optional-parent
steps:
  - do: issue.create
    as: issue
    with:
      title: child
      typeRole: task
      parentId: \${missing}
`);
    const { context } = await runRecipe(recipe, { ports: allPorts(), asker: scriptedAsker() });
    // parentId resolved to undefined -> no hierarchy emulation label applied.
    expect((context.issue as { labels: string[] }).labels).not.toContain('parent:undefined');
  });

  it('forwards the query limit instead of dropping it', async () => {
    const recipe = loadRecipe(`
name: query-limit
steps:
  - do: issue.create
    with:
      title: a
      typeRole: task
      initialRole: in_review
  - do: issue.create
    with:
      title: b
      typeRole: task
      initialRole: in_review
  - do: issue.query
    as: found
    with:
      role: in_review
      limit: 1
`);
    const { context } = await runRecipe(recipe, { ports: allPorts(), asker: scriptedAsker() });
    expect((context.found as unknown[]).length).toBe(1);
  });

  it('captures a learning and a follow-up through the knowledge loop', async () => {
    const recipe = loadRecipe(`
name: capture
steps:
  - do: learning.append
    as: note
    with:
      title: Roles beat states
      body: Recipes speak abstract roles.
      tags: [design]
  - do: followup.append
    with:
      title: Wire live smoke
      tags: [debt]
  - do: learning.query
    as: found
    with:
      tag: design
`);
    const { context } = await runRecipe(recipe, { ports: allPorts(), asker: scriptedAsker() });
    expect((context.note as { id: string }).id).toBeTruthy();
    expect((context.found as unknown[]).length).toBe(1);
  });

  // The guard that exists because this recipe once merged a PR whose checks were failing and turned
  // main red. These run the SHIPPED task-land.yaml, not a copy of it — a gate that only holds in a
  // test fixture is the thing being guarded against.
  describe('task-land checks gate', () => {
    const taskLand = loadRecipe(
      readFileSync(fileURLToPath(new URL('../recipes/task-land.yaml', import.meta.url)), 'utf8'),
    );

    async function landable(checks?: CheckSummary) {
      const issues = issuesPort();
      const scm = defineGithubScmAdapter(
        createMemoryScmTransport(checks === undefined ? {} : { checks }),
      );
      const issue = await issues.create({ title: 'boom', typeRole: 'bug' });
      const branch = issue.branchName as string;
      await scm.createBranch({ name: branch, fromBranch: 'main' });
      const pr = await scm.createPullRequest({ title: 'fix', sourceBranch: branch, draft: true });
      return { ports: { issues, scm } as RecipePorts, scm, issue, pr };
    }

    const summary = (over: Partial<CheckSummary>): CheckSummary => ({
      total: 1,
      succeeded: 0,
      failed: 0,
      pending: 0,
      rollup: 'succeeded',
      ...over,
    });

    it('refuses to land a pull request whose checks failed', async () => {
      const { ports, scm, issue, pr } = await landable(summary({ failed: 1, rollup: 'failed' }));
      await expect(
        runRecipe(taskLand, { ports, asker: scriptedAsker([issue.id]) }),
      ).rejects.toThrow(/failing checks/);
      // And it stops BEFORE any mutation: still a draft, still open.
      const after = await scm.prStatus(pr.id);
      expect(after.state).toBe('open');
      expect((await scm.prForBranch(issue.branchName as string))?.draft).toBe(true);
    });

    it('refuses to land while checks are still running', async () => {
      const { ports, issue, scm } = await landable(summary({ pending: 1, rollup: 'pending' }));
      await expect(
        runRecipe(taskLand, { ports, asker: scriptedAsker([issue.id]) }),
      ).rejects.toThrow(/still has checks running/);
      expect((await scm.prForBranch(issue.branchName as string))?.state).toBe('open');
    });

    // A fine-grained token cannot be granted the Checks permission at all, so refusing here would
    // make task-land unusable for the very token `baron init` recommends. Loud, not fatal.
    it('lands on an unreadable rollup but says so', async () => {
      const { ports, issue } = await landable(
        summary({ total: 0, rollup: 'unknown', unreadable: ['checks'] }),
      );
      const asker = scriptedAsker([issue.id]);
      await runRecipe(taskLand, { ports, asker });
      expect(asker.notes.some((n) => n.includes('WARNING') && n.includes('unknown'))).toBe(true);
    });

    it('lands quietly when every check passed', async () => {
      const { ports, issue, scm } = await landable();
      const asker = scriptedAsker([issue.id]);
      await runRecipe(taskLand, { ports, asker });
      expect(asker.notes.some((n) => n.includes('WARNING'))).toBe(false);
      expect((await scm.prForBranch(issue.branchName as string, 'merged'))?.state).toBe('merged');
    });
  });

  it('throws PORT_UNBOUND when a recipe needs an unconfigured port', async () => {
    const recipe = loadRecipe(`
name: needs-scm
steps:
  - do: scm.branch.create
    with: { name: feature/x, fromBranch: main }
`);
    // The code alone leaves a user stuck: it says which port is missing but not where to bind it,
    // and a provider that ships no scm adapter (Linear) makes that the first wall a new install hits.
    await expect(
      runRecipe(recipe, { ports: { issues: issuesPort() }, asker: scriptedAsker() }),
    ).rejects.toThrow(/policy\.providers\.scm/);
  });

  it('rejects an out-of-enum role argument', async () => {
    const recipe = loadRecipe(`
name: bad-role
steps:
  - do: issue.create
    as: issue
    with:
      title: x
      typeRole: task
  - do: issue.transition
    with:
      id: \${issue.id}
      role: shipped
`);
    await expect(runRecipe(recipe, { ports: allPorts(), asker: scriptedAsker() })).rejects.toThrow(
      /not a role/,
    );
  });
});

// Blocking is orthogonal, so it is its own op rather than a role a transition could take. Without
// these a recipe could not set or clear the flag at all — and could not guard on it, so nothing
// could express "refuse to land a blocked item", which is the first rule anyone would want.
describe('issue.block / issue.unblock as recipe ops', () => {
  const blockThenRead = `
name: block-it
steps:
  - do: issue.create
    as: issue
    with: { title: "stuck", typeRole: task }
  - do: issue.transition
    as: issue
    with: { id: "\${issue.id}", role: in_review }
  - do: issue.block
    as: blocked
    with: { id: "\${issue.id}", reason: "waiting on the vendor" }
  - message: "\${blocked.key} blocked=\${blocked.blocked} role=\${blocked.role}"
`;

  it('blocks without moving the item, and the role survives in the run context', async () => {
    const asker = scriptedAsker();
    const { context } = await runRecipe(loadRecipe(blockThenRead), { ports: allPorts(), asker });
    const blocked = context.blocked as { blocked: boolean; role?: string };
    expect(blocked.blocked).toBe(true);
    expect(blocked.role).toBe('in_review');
    expect(
      asker.notes.some((n) => n.includes('blocked=true') && n.includes('role=in_review')),
    ).toBe(true);
  });

  it('a guard can refuse on the flag — the reason recipes exist', async () => {
    const recipe = loadRecipe(`
name: refuse-blocked
steps:
  - do: issue.create
    as: issue
    with: { title: "stuck", typeRole: task }
  - do: issue.block
    as: issue
    with: { id: "\${issue.id}", reason: "waiting" }
  - require:
      falsy: "\${issue.blocked}"
      message: "\${issue.key} is blocked — unblock it before landing."
  - do: issue.comment
    with: { id: "\${issue.id}", body: "never reached" }
`);
    await expect(runRecipe(recipe, { ports: allPorts(), asker: scriptedAsker() })).rejects.toThrow(
      /is blocked/,
    );
  });

  it('unblock clears the flag and leaves the role where it was', async () => {
    const recipe = loadRecipe(`
name: unblock-it
steps:
  - do: issue.create
    as: issue
    with: { title: "stuck", typeRole: task }
  - do: issue.transition
    with: { id: "\${issue.id}", role: in_review }
  - do: issue.block
    with: { id: "\${issue.id}", reason: "waiting" }
  - do: issue.unblock
    as: cleared
    with: { id: "\${issue.id}", reason: "vendor replied" }
`);
    const { context } = await runRecipe(recipe, { ports: allPorts(), asker: scriptedAsker() });
    const cleared = context.cleared as { blocked: boolean; role?: string };
    expect(cleared.blocked).toBe(false);
    expect(cleared.role).toBe('in_review');
  });

  it('refuses a block with no reason, from the engine rather than the agent', async () => {
    const recipe = loadRecipe(`
name: no-reason
steps:
  - do: issue.create
    as: issue
    with: { title: "stuck", typeRole: task }
  - do: issue.block
    with: { id: "\${issue.id}", reason: "" }
`);
    await expect(runRecipe(recipe, { ports: allPorts(), asker: scriptedAsker() })).rejects.toThrow(
      /reason/i,
    );
  });
});

// A guard that cannot express a count is a real limit on decision #19: the rules are supposed to
// live in the engine, and "refuse when the query found nothing" is the first one anyone would write.
describe('guarding on a count', () => {
  it('a require can refuse on an empty result', async () => {
    const recipe = loadRecipe(`
name: needs-a-match
steps:
  - do: issue.query
    as: found
    with: { role: in_review }
  - require:
      truthy: "\${found.length}"
      message: "nothing in review — found \${found.length}."
  - message: "reviewing \${found.length}"
`);
    await expect(runRecipe(recipe, { ports: allPorts(), asker: scriptedAsker() })).rejects.toThrow(
      /nothing in review/,
    );
  });

  it('and passes once there is one, reporting the count', async () => {
    const recipe = loadRecipe(`
name: has-a-match
steps:
  - do: issue.create
    as: issue
    with: { title: "one", typeRole: task }
  - do: issue.transition
    with: { id: "\${issue.id}", role: in_review }
  - do: issue.query
    as: found
    with: { role: in_review }
  - require:
      truthy: "\${found.length}"
      message: "nothing in review"
  - message: "reviewing \${found.length}"
`);
    const asker = scriptedAsker();
    await runRecipe(recipe, { ports: allPorts(), asker });
    expect(asker.notes.some((n) => n === 'reviewing 1')).toBe(true);
  });
});

// The number zero is a count here, never an identity. A work item whose id is the STRING '0' is
// present; a list whose length is the NUMBER 0 is empty. Guards have to tell those apart.
describe('zero in a guard', () => {
  it("treats a count of zero as absent but an id of '0' as present", async () => {
    const refusesOnZero = loadRecipe(`
name: zero-count
steps:
  - require:
      truthy: "\${count}"
      message: "count was \${count}"
`);
    await expect(
      runRecipe(refusesOnZero, { ports: allPorts(), asker: scriptedAsker(), inputs: { count: 0 } }),
    ).rejects.toThrow(/count was 0/);

    const passesOnZeroId = loadRecipe(`
name: zero-id
steps:
  - require:
      truthy: "\${id}"
      message: "no id"
  - message: "id is \${id}"
`);
    const asker = scriptedAsker();
    await runRecipe(passesOnZeroId, { ports: allPorts(), asker, inputs: { id: '0' } });
    expect(asker.notes.some((n) => n === 'id is 0')).toBe(true);
  });
});

// The governance the task-move skill described in prose, now enforced by the engine: which moves
// need justifying is the recipe's opinion, the order they are judged against is core's.
describe('task-move', () => {
  const taskMove = loadRecipe(
    readFileSync(fileURLToPath(new URL('../recipes/task-move.yaml', import.meta.url)), 'utf8'),
  );

  async function anItemIn(role: string) {
    const ports = allPorts();
    const issue = await (ports.issues as IssuesPort).create({ title: 'movable', typeRole: 'task' });
    if (role !== 'backlog') {
      await (ports.issues as IssuesPort).transition(issue.id, role as 'in_review');
    }
    return { ports, id: issue.id };
  }

  it('advances without demanding a reason', async () => {
    const { ports, id } = await anItemIn('backlog');
    const asker = scriptedAsker([id, 'in_review', undefined]);
    await runRecipe(taskMove, { ports, asker });
    expect((await (ports.issues as IssuesPort).get(id)).role).toBe('in_review');
  });

  it('refuses a backward move with no reason on the record', async () => {
    const { ports, id } = await anItemIn('in_review');
    await expect(
      runRecipe(taskMove, { ports, asker: scriptedAsker([id, 'in_progress', undefined]) }),
    ).rejects.toThrow(/moves? backwards/i);
    // and it stopped BEFORE the move
    expect((await (ports.issues as IssuesPort).get(id)).role).toBe('in_review');
  });

  it('allows the same backward move once a reason is given', async () => {
    const { ports, id } = await anItemIn('in_review');
    const asker = scriptedAsker([id, 'in_progress', 'review found a broken migration']);
    await runRecipe(taskMove, { ports, asker });
    expect((await (ports.issues as IssuesPort).get(id)).role).toBe('in_progress');
  });

  it('refuses to reopen finished work without one', async () => {
    const { ports, id } = await anItemIn('done');
    await expect(
      runRecipe(taskMove, { ports, asker: scriptedAsker([id, 'in_progress', undefined]) }),
    ).rejects.toThrow(/reopening/i);
  });

  it('reports a no-op instead of writing anything', async () => {
    const { ports, id } = await anItemIn('in_review');
    const asker = scriptedAsker([id, 'in_review', undefined]);
    await runRecipe(taskMove, { ports, asker });
    expect(asker.notes.some((n) => n.includes('already in_review'))).toBe(true);
  });
});

// The relation reached the port through core and the adapter, and stopped at the engine — so the
// recipe asked for `relates` and the PR still said Closes. A layer that silently drops an argument
// is worse than one that rejects it.
describe('scm.pr.create carries the issue relation', () => {
  const recipe = (relation: string) =>
    loadRecipe(`
name: link-it
steps:
  - do: scm.pr.create
    as: pr
    with:
      title: t
      sourceBranch: feature/x
      targetBranch: main
      linkedIssueKey: "12"
      linkedIssueRelation: ${relation}
`);

  it('passes it down rather than dropping it', async () => {
    const seen: unknown[] = [];
    const ports: RecipePorts = {
      scm: {
        createPullRequest: async (draft: unknown) => {
          seen.push(draft);
          return {
            id: '1',
            title: 't',
            sourceBranch: 'feature/x',
            targetBranch: 'main',
            draft: false,
          };
        },
      } as unknown as ScmPort,
    };
    await runRecipe(recipe('relates'), { ports, asker: scriptedAsker() });
    expect((seen[0] as { linkedIssueRelation?: string }).linkedIssueRelation).toBe('relates');
  });

  it('rejects a relation the union does not have, naming the ones it does', async () => {
    await expect(
      runRecipe(recipe('mentions'), { ports: allPorts(), asker: scriptedAsker() }),
    ).rejects.toThrow(/closes, relates/);
  });
});

describe('for_each', () => {
  // The grammar was four single-shot step kinds, so a workflow that sweeps N items could not be
  // written at all — which is why the one sweeping workflow Baron ships lived as prose in a skill,
  // unable even to run on an install that routes mutations through recipes.
  it('runs its steps once per element and collects what matched', async () => {
    const recipe = loadRecipe(`
name: sweep
steps:
  - do: issue.query
    as: items
    with: { role: in_progress }
  - for_each: \${items}
    as: item
    collect: { as: moved, from: "\${done.key}" }
    steps:
      - do: issue.transition
        as: done
        with: { id: "\${item.id}", role: done }
`);
    const issues = issuesPort();
    for (const title of ['one', 'two']) {
      const created = await issues.create({ title, typeRole: 'task' });
      await issues.transition(created.id, 'in_progress');
    }
    const { context } = await runRecipe(recipe, { ports: { issues }, asker: scriptedAsker() });
    expect((context.moved as string[]).length).toBe(2);
    for (const issue of await issues.query({ role: 'done' })) {
      expect(issue.role).toBe('done');
    }
  });

  it('does not leak a binding made inside an iteration', async () => {
    // Leaking would mean the LAST element silently wins for anything read after the loop — a bug
    // that reads as data, because the value is real, just not the one the author meant.
    const recipe = loadRecipe(`
name: scope
steps:
  - do: issue.query
    as: items
    with: { role: backlog }
  - for_each: \${items}
    as: item
    steps:
      - do: issue.get
        as: seen
        with: { id: "\${item.id}" }
`);
    const issues = issuesPort();
    await issues.create({ title: 'only', typeRole: 'task' });
    const { context } = await runRecipe(recipe, { ports: { issues }, asker: scriptedAsker() });
    expect(context.seen, 'an iteration binding escaped the loop').toBeUndefined();
  });

  it('binds an empty list rather than nothing when the sweep matched none', async () => {
    const recipe = loadRecipe(`
name: empty
steps:
  - do: issue.query
    as: items
    with: { role: in_review }
  - for_each: \${items}
    as: item
    collect: { as: moved, from: "\${item.id}" }
    steps:
      - message: "never"
`);
    const { context } = await runRecipe(recipe, {
      ports: { issues: issuesPort() },
      asker: scriptedAsker(),
    });
    expect(context.moved).toEqual([]);
  });

  it('refuses to sweep something that is not a list', async () => {
    // Quietly doing nothing is how a sweep reports "all clear" for a board it never read.
    const recipe = loadRecipe(`
name: bad
steps:
  - for_each: \${nothing}
    as: item
    steps:
      - message: "never"
`);
    await expect(
      runRecipe(recipe, { ports: { issues: issuesPort() }, asker: scriptedAsker() }),
    ).rejects.toThrow(/expected a list/);
  });
});
