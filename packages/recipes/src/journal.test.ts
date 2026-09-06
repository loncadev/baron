import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defineGithubIssuesAdapter,
  defineGithubScmAdapter,
  exampleGithubRoleMap,
  exampleGithubTypeMap,
  recommendedGithubGapPolicy,
} from '@lonca/baron-adapter-github';
import { createMemoryScmTransport, createMemoryTransport } from '@lonca/baron-conformance';
import { BaronError, type IssuesPort } from '@lonca/baron-core';
import { afterEach, describe, expect, it } from 'vitest';
import type { RecipeAsker } from './ask.js';
import { type RecipePorts, runRecipe } from './engine.js';
import {
  RUN_JOURNAL_CORRUPT,
  RUN_NOT_FOUND,
  RUN_RECIPE_CHANGED,
  canonicalJson,
  createFileRunJournal,
  createMemoryRunJournal,
  newRunId,
  recipeFingerprint,
  runJournalPath,
  stepKey,
} from './journal.js';
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

/** The port, with every method call counted by name — the proof that a replayed step did not run. */
function counted<T extends object>(port: T): { port: T; calls: Map<string, number> } {
  const calls = new Map<string, number>();
  const proxied = new Proxy(port, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.set(String(prop), (calls.get(String(prop)) ?? 0) + 1);
        return Reflect.apply(value, target, args);
      };
    },
  });
  return { port: proxied, calls };
}

function asker(answers: (string | undefined)[] = []): RecipeAsker & { notes: string[] } {
  const notes: string[] = [];
  let cursor = 0;
  return {
    notes,
    async text() {
      if (cursor >= answers.length) throw new Error('asked more than scripted');
      return answers[cursor++];
    },
    async confirm() {
      return true;
    },
    async choice(_m, choices) {
      return choices[0] ?? '';
    },
    note(m) {
      notes.push(m);
    },
  };
}

/** Creates an issue, opens a PR for it, then needs a port the first run does not have. */
const shipLike = `
name: ship-like
steps:
  - ask: { as: title, type: text, message: "Title?" }
  - do: issue.create
    as: issue
    with: { title: "\${title}", typeRole: task }
  - do: scm.pr.create
    as: pr
    with: { title: "\${title}", sourceBranch: "feature/\${issue.id}", draft: true }
  - message: "PR \${pr.id} open"
  - do: notify.send
    with: { text: "shipped \${issue.key}" }
  - message: "done"
`;

describe('the run journal store', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('appends one JSON line per entry under .baron/runs and reads them back in order', () => {
    const root = mkdtempSync(join(tmpdir(), 'baron-journal-'));
    dirs.push(root);
    const store = createFileRunJournal(root);
    const id = newRunId();
    store.append(id, { kind: 'start', at: 't0', recipe: 'x', fingerprint: 'f', inputs: {} });
    store.append(id, { kind: 'note', at: 't1', text: 'hello' });
    expect(readFileSync(runJournalPath(root, id), 'utf8').split('\n').filter(Boolean)).toHaveLength(
      2,
    );
    expect(store.read(id)?.map((e) => e.kind)).toEqual(['start', 'note']);
    expect(store.read('never-started')).toBeUndefined();
  });

  it('refuses a journal it cannot read rather than resuming from half of it', () => {
    const root = mkdtempSync(join(tmpdir(), 'baron-journal-'));
    dirs.push(root);
    const store = createFileRunJournal(root);
    store.append('r1', { kind: 'start', at: 't0', recipe: 'x', fingerprint: 'f', inputs: {} });
    writeFileSync(runJournalPath(root, 'r1'), '{"kind":"start"}\nnot json\n');
    expect(() => store.read('r1')).toThrow(expect.objectContaining({ code: RUN_JOURNAL_CORRUPT }));
  });

  it('rejects a run id that could name a path', () => {
    expect(() => runJournalPath('/p', '../etc/passwd')).toThrow(
      expect.objectContaining({ code: RUN_NOT_FOUND }),
    );
  });

  it('keys a step by run, position, op and canonical parameters', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}',
    );
    const k = stepKey('r', '2', 'scm.pr.create', { title: 'x', draft: true });
    expect(stepKey('r', '2', 'scm.pr.create', { draft: true, title: 'x' })).toBe(k);
    expect(stepKey('r', '3', 'scm.pr.create', { title: 'x', draft: true })).not.toBe(k);
    expect(stepKey('r', '2', 'scm.pr.create', { title: 'y', draft: true })).not.toBe(k);
    expect(stepKey('other', '2', 'scm.pr.create', { title: 'x', draft: true })).not.toBe(k);
  });

  it('fingerprints the instructions, not the text', () => {
    const a = loadRecipe('name: r\nsteps:\n  - message: "hi"\n');
    const b = loadRecipe('name: r\n# a comment\nsteps:\n    - message:   "hi"\n');
    const c = loadRecipe('name: r\nsteps:\n  - message: "hi!"\n');
    expect(recipeFingerprint(a)).toBe(recipeFingerprint(b));
    expect(recipeFingerprint(a)).not.toBe(recipeFingerprint(c));
  });
});

describe('a journaled run', () => {
  it('records inputs, answers, each do step with its result, notes and the end', async () => {
    const journal = createMemoryRunJournal();
    const ports: RecipePorts = {
      issues: issuesPort(),
      scm: defineGithubScmAdapter(createMemoryScmTransport()),
    };
    const recipe = loadRecipe(`
name: two-steps
steps:
  - ask: { as: title, type: text, message: "Title?" }
  - do: issue.create
    as: issue
    with: { title: "\${title}", typeRole: task }
  - message: "made \${issue.key}"
`);
    const result = await runRecipe(recipe, {
      ports,
      asker: asker(['Journaled']),
      inputs: { seeded: 'yes' },
      run: { id: 'run-1', journal },
    });
    expect(result.runId).toBe('run-1');
    expect(result.replayed).toBe(0);
    const entries = journal.read('run-1') ?? [];
    expect(entries.map((e) => e.kind)).toEqual(['start', 'ask', 'do', 'note', 'end']);
    expect(entries[0]).toMatchObject({ recipe: 'two-steps', inputs: { seeded: 'yes' } });
    expect(entries[1]).toMatchObject({ as: 'title', value: 'Journaled' });
    expect(entries[2]).toMatchObject({
      path: '1',
      op: 'issue.create',
      as: 'issue',
      result: { title: 'Journaled' },
    });
  });

  it('resumes after a failure: completed steps are replayed, not repeated, and the run finishes', async () => {
    const journal = createMemoryRunJournal();
    const issues = counted(issuesPort());
    const scm = counted(defineGithubScmAdapter(createMemoryScmTransport()));
    const recipe = loadRecipe(shipLike);

    // First attempt: no notify port, so the run stops after the PR is open.
    const first = runRecipe(recipe, {
      ports: { issues: issues.port, scm: scm.port },
      asker: asker(['Ship it']),
      run: { id: 'ship-1', journal },
    });
    await expect(first).rejects.toMatchObject({
      code: 'PORT_UNBOUND',
      details: { run: { id: 'ship-1', step: '4', op: 'notify.send' } },
    });
    const stopped = journal.read('ship-1') ?? [];
    expect(stopped.at(-1)).toMatchObject({ kind: 'error', path: '4', op: 'notify.send' });
    const prBefore = (
      stopped.find((e) => e.kind === 'do' && e.op === 'scm.pr.create') as {
        result?: { id: string };
      }
    ).result;

    // Second attempt, with the missing port: nothing before the failure runs again.
    const sent: string[] = [];
    const notify = {
      send: async (m: { text: string }) => {
        sent.push(m.text);
        return { id: 'n1' };
      },
    };
    const resumed = await runRecipe(recipe, {
      ports: { issues: issues.port, scm: scm.port, notify: notify as never },
      asker: asker([]), // an ask on resume would throw: the answer must come from the journal
      run: { id: 'ship-1', journal, resume: true },
    });
    expect(resumed.replayed).toBe(2);
    expect((resumed.context.pr as { id: string }).id).toBe(prBefore?.id);
    expect(issues.calls.get('create')).toBe(1);
    expect([...scm.calls].filter(([k]) => /create/i.test(k)).reduce((n, [, c]) => n + c, 0)).toBe(
      1,
    );
    expect(sent).toHaveLength(1);
    expect(resumed.notes.filter((n) => n.startsWith('Replayed'))).toHaveLength(2);
    expect((journal.read('ship-1') ?? []).map((e) => e.kind)).toEqual([
      'start',
      'ask',
      'do',
      'do',
      'note',
      'error',
      'resume',
      'note',
      'do',
      'note',
      'end',
    ]);
  });

  it('refuses to resume a run whose recipe has changed, an unknown run, or a finished one', async () => {
    const journal = createMemoryRunJournal();
    const ports: RecipePorts = { issues: issuesPort() };
    const recipe = loadRecipe('name: r\nsteps:\n  - message: "one"\n');
    await runRecipe(recipe, { ports, asker: asker(), run: { id: 'done-1', journal } });
    await expect(
      runRecipe(recipe, { ports, asker: asker(), run: { id: 'done-1', journal, resume: true } }),
    ).rejects.toMatchObject({
      code: RUN_NOT_FOUND,
      message: expect.stringMatching(/already finished/),
    });
    await expect(
      runRecipe(recipe, { ports, asker: asker(), run: { id: 'nope', journal, resume: true } }),
    ).rejects.toMatchObject({ code: RUN_NOT_FOUND });

    journal.append('half', {
      kind: 'start',
      at: 't',
      recipe: 'r',
      fingerprint: recipeFingerprint(recipe),
      inputs: {},
    });
    const changed = loadRecipe('name: r\nsteps:\n  - message: "one"\n  - message: "two"\n');
    await expect(
      runRecipe(changed, { ports, asker: asker(), run: { id: 'half', journal, resume: true } }),
    ).rejects.toMatchObject({ code: RUN_RECIPE_CHANGED });
  });

  it('keys for_each iterations by element, so a sweep resumes at the element that failed', async () => {
    const journal = createMemoryRunJournal();
    const issues = counted(issuesPort());
    const recipe = loadRecipe(`
name: sweep
steps:
  - for_each: "\${titles}"
    as: t
    steps:
      - do: issue.create
        as: made
        with: { title: "\${t}", typeRole: task }
      - do: issue.comment
        with: { id: "\${made.id}", body: "\${t}" }
`);
    // The comment op is unavailable through a port that lacks it: emulate by stripping the method
    // after the second element's create, via a port that throws on the third call.
    let comments = 0;
    const flaky = new Proxy(issues.port, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== 'comment' || typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          comments += 1;
          if (comments === 2) throw new BaronError('network blip', 'PROVIDER_UNAVAILABLE');
          return Reflect.apply(value, target, args);
        };
      },
    });
    const inputs = { titles: ['a', 'b', 'c'] };
    await expect(
      runRecipe(recipe, {
        ports: { issues: flaky },
        asker: asker(),
        inputs,
        run: { id: 's', journal },
      }),
    ).rejects.toMatchObject({ details: { run: { step: '0[1]/1', op: 'issue.comment' } } });
    expect(issues.calls.get('create')).toBe(2);

    const resumed = await runRecipe(recipe, {
      ports: { issues: issues.port },
      asker: asker(),
      run: { id: 's', journal, resume: true },
    });
    // Element a: both steps replayed. Element b: create replayed, comment runs. Element c: both run.
    expect(resumed.replayed).toBe(3);
    expect(issues.calls.get('create')).toBe(3);
  });
});
