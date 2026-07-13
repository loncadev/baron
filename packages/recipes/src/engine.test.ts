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

  it('throws PORT_UNBOUND when a recipe needs an unconfigured port', async () => {
    const recipe = loadRecipe(`
name: needs-scm
steps:
  - do: scm.branch.create
    with: { name: feature/x, fromBranch: main }
`);
    await expect(
      runRecipe(recipe, { ports: { issues: issuesPort() }, asker: scriptedAsker() }),
    ).rejects.toBeInstanceOf(BaronError);
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
