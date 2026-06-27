import {
  defineGithubIssuesAdapter,
  defineGithubScmAdapter,
  exampleGithubRoleMap,
  exampleGithubTypeMap,
  recommendedGithubGapPolicy,
} from '@baron/adapter-github';
import { createMemoryScmTransport, createMemoryTransport } from '@baron/conformance';
import { BaronError, type IssuesPort, type ScmPort } from '@baron/core';
import { KnowledgeLoop, createMemoryKnowledgeStore } from '@baron/knowledge-loop';
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
