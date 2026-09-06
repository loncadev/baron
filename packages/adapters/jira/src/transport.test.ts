import { TransitionFieldsRequiredError, TransitionNotPermittedError } from '@lonca/baron-core';
import { describe, expect, it } from 'vitest';
import { defineJiraIssuesAdapter, exampleJiraRoleMap, exampleJiraTypeMap } from './index.js';
import { JIRA_STATE_KEY } from './provider.js';
import { createJiraTransport } from './transport.js';

/**
 * A fetch that records every request and answers from a queue, so a test can assert what the
 * transport SENT — the blind spot the in-memory conformance suite structurally has, and the one
 * that let a literal '@me' and an empty PR body reach real providers before.
 */
interface Sent {
  method: string;
  url: string;
  body?: unknown;
  headers: Record<string, string>;
}

/** The sprint field as this fake site's catalogue names it; the id is what real sites vary. */
const SPRINT_FIELD = 'customfield_10020';
const FIELD_CATALOGUE = [
  { id: 'summary', schema: { type: 'string' } },
  { id: SPRINT_FIELD, name: 'Sprint', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
];

function fakeFetch(queue: Array<{ status?: number; body?: unknown }>) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    sent.push({
      method: init?.method ?? 'GET',
      url,
      headers: (init?.headers as Record<string, string>) ?? {},
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
    });
    // The field catalogue is read once per transport to find the sprint field's id. Answered by
    // route rather than from the queue, so a test scripts only the calls it is about.
    if (/\/rest\/api\/2\/field$/.test(url)) {
      return { ok: true, status: 200, text: async () => JSON.stringify(FIELD_CATALOGUE) };
    }
    const next = queue.shift() ?? { status: 200, body: {} };
    const status = next.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (next.body === undefined ? '' : JSON.stringify(next.body)),
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

const issue = (key: string, status: string, extra: Record<string, unknown> = {}) => ({
  id: '10001',
  key,
  fields: {
    summary: 'Wire the thing',
    description: 'Because.',
    status: { id: '1', name: status },
    issuetype: { id: '3', name: 'Task' },
    labels: ['in-progress'],
    ...extra,
  },
});

const transport = (queue: Array<{ status?: number; body?: unknown }>) => {
  const fake = fakeFetch(queue);
  const t = createJiraTransport({
    site: 'https://acme.atlassian.net/',
    email: 'dev@acme.test',
    apiToken: 'tok',
    project: 'PROJ',
    fetchImpl: fake.fetchImpl,
  });
  return { t, sent: fake.sent };
};

describe('the Jira transport speaks REST v2 the way Jira expects', () => {
  it('authenticates with Basic email:token, on the site root without its trailing slash', async () => {
    const { t, sent } = transport([{ body: issue('PROJ-1', 'To Do') }]);
    await t.getIssue('PROJ-1');
    // The catalogue read comes first (once), then the issue, asking for the sprint field by the
    // id the catalogue gave it.
    const read = sent.find((s) => s.url.includes('/issue/'));
    expect(read?.url).toBe(
      `https://acme.atlassian.net/rest/api/2/issue/PROJ-1?fields=summary,description,status,issuetype,parent,labels,assignee,${SPRINT_FIELD}`,
    );
    expect(read?.headers.authorization).toBe(
      `Basic ${Buffer.from('dev@acme.test:tok').toString('base64')}`,
    );
  });

  it('creates with project, type, parent and labels, then reads the issue back', async () => {
    const { t, sent } = transport([
      { status: 201, body: { id: '10002', key: 'PROJ-2' } },
      { body: issue('PROJ-2', 'To Do', { parent: { id: '1', key: 'PROJ-1' } }) },
    ]);
    const created = await t.createIssue({
      title: 'Wire the thing',
      body: 'Because.',
      nativeType: 'Task',
      typeRole: 'task',
      parentId: 'PROJ-1',
      labels: ['type:task'],
    });
    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.body).toEqual({
      fields: {
        project: { key: 'PROJ' },
        summary: 'Wire the thing',
        issuetype: { name: 'Task' },
        description: 'Because.',
        parent: { key: 'PROJ-1' },
        labels: ['type:task'],
      },
    });
    // The key is the id: it is what every endpoint takes and what a person calls the issue.
    expect(created.id).toBe('PROJ-2');
    expect(created.parentId).toBe('PROJ-1');
    expect(created.discriminator).toBe('To Do');
    expect(created.url).toBe('https://acme.atlassian.net/browse/PROJ-2');
  });

  it('applies a target by performing the transition whose destination is that status', async () => {
    const { t, sent } = transport([
      {
        body: { transitions: [{ id: '21', name: 'Start', to: { id: '3', name: 'In Progress' } }] },
      },
      { status: 204 },
      { body: issue('PROJ-1', 'In Progress') },
    ]);
    const moved = await t.applyTarget(
      'PROJ-1',
      { [JIRA_STATE_KEY]: 'In Progress' },
      { resolution: { name: 'Fixed' } },
    );
    expect(sent[1]?.method).toBe('POST');
    expect(sent[1]?.url).toMatch(/\/issue\/PROJ-1\/transitions$/);
    // The screen's answers travel untouched, in the shape Jira wants them.
    expect(sent[1]?.body).toEqual({
      transition: { id: '21' },
      fields: { resolution: { name: 'Fixed' } },
    });
    expect(moved.discriminator).toBe('In Progress');
  });

  it('refuses a target no transition reaches, naming what the workflow permits', async () => {
    const { t } = transport([
      {
        body: { transitions: [{ id: '21', name: 'Start', to: { id: '3', name: 'In Progress' } }] },
      },
    ]);
    await expect(t.applyTarget('PROJ-1', { [JIRA_STATE_KEY]: 'Done' })).rejects.toThrow(
      /no transition to 'Done'.*permits: In Progress/,
    );
  });

  it('reports reachable targets and the fields a transition screen demands', async () => {
    const screen = {
      transitions: [
        {
          id: '31',
          name: 'Resolve',
          to: { id: '5', name: 'Done' },
          fields: {
            resolution: {
              required: true,
              name: 'Resolution',
              allowedValues: [{ name: 'Fixed' }, { name: "Won't Do" }],
            },
            fixVersions: { required: false, name: 'Fix versions', allowedValues: [] },
          },
        },
      ],
    };
    const { t, sent } = transport([{ body: screen }, { body: screen }]);
    expect(await t.availableTargets?.('PROJ-1')).toEqual([{ [JIRA_STATE_KEY]: 'Done' }]);
    expect(await t.transitionFields?.('PROJ-1', { [JIRA_STATE_KEY]: 'Done' })).toEqual([
      { name: 'resolution', required: true, allowedValues: ['Fixed', "Won't Do"] },
      { name: 'fixVersions', required: false },
    ]);
    // Only the second read asks for the screens; the first is the cheap one.
    expect(sent[0]?.url).not.toContain('expand');
    expect(sent[1]?.url).toContain('expand=transitions.fields');
  });

  it('builds a project-scoped JQL with the plural status filter, the type, and currentUser()', async () => {
    const { t, sent } = transport([{ body: { issues: [issue('PROJ-1', 'In Review')] } }]);
    await t.queryIssues({
      targets: [{ [JIRA_STATE_KEY]: 'In Progress' }, { [JIRA_STATE_KEY]: 'In Review' }],
      nativeType: 'Bug',
      assignee: '@me',
      limit: 7,
    });
    const search = sent.find((s) => s.url.endsWith('/search/jql'));
    expect(search?.method).toBe('POST');
    expect(search?.body).toMatchObject({
      jql: 'project = "PROJ" AND status in ("In Progress", "In Review") AND issuetype = "Bug" AND assignee = currentUser() ORDER BY updated DESC',
      maxResults: 7,
    });
  });

  it('escapes a status name that would otherwise break out of its JQL literal', async () => {
    const { t, sent } = transport([{ body: { issues: [] } }]);
    await t.queryIssues({ targets: [{ [JIRA_STATE_KEY]: 'Won\'t "Do" \\ ever' }] });
    const search = sent.find((s) => s.url.endsWith('/search/jql'));
    expect((search?.body as { jql: string }).jql).toContain(
      'status in ("Won\'t \\"Do\\" \\\\ ever")',
    );
  });

  it('adds and removes labels through the update verb, never by rewriting the label list', async () => {
    const { t, sent } = transport([{ status: 204 }, { status: 204 }]);
    await t.addLabel('PROJ-1', 'blocked');
    await t.removeLabel?.('PROJ-1', 'in-progress');
    expect(sent[0]?.body).toEqual({ update: { labels: [{ add: 'blocked' }] } });
    expect(sent[1]?.body).toEqual({ update: { labels: [{ remove: 'in-progress' }] } });
  });

  it('links with `from` on the outward side, which is how Jira names a directional link', async () => {
    const { t, sent } = transport([{ status: 201 }]);
    await t.linkIssues('PROJ-1', 'PROJ-2', 'Blocks');
    expect(sent[0]?.body).toEqual({
      type: { name: 'Blocks' },
      outwardIssue: { key: 'PROJ-1' },
      inwardIssue: { key: 'PROJ-2' },
    });
  });

  it("resolves '@me' to the token holder's accountId before assigning", async () => {
    const { t, sent } = transport([
      { body: { accountId: 'acc-1', emailAddress: 'dev@acme.test' } },
      { status: 204 },
      {
        body: issue('PROJ-1', 'To Do', {
          assignee: { accountId: 'acc-1', emailAddress: 'dev@acme.test' },
        }),
      },
    ]);
    const assigned = await t.assignIssue('PROJ-1', '@me');
    expect(sent[0]?.url).toMatch(/\/myself$/);
    expect(sent[1]?.body).toEqual({ accountId: 'acc-1' });
    // The handle read back is the one currentUser() reports, so the two compare equal.
    expect(assigned.assignee).toBe('dev@acme.test');
    expect(
      await transport([
        { body: { accountId: 'acc-1', emailAddress: 'dev@acme.test' } },
      ]).t.currentUser(),
    ).toBe('dev@acme.test');
  });

  it('surfaces every message Jira sends, per-field ones included', async () => {
    const { t } = transport([
      {
        status: 400,
        body: {
          errorMessages: ['Transition failed'],
          errors: { resolution: 'Resolution is required.' },
        },
      },
    ]);
    await expect(t.getIssue('PROJ-1')).rejects.toThrow(
      /HTTP 400 — Transition failed; resolution: Resolution is required\./,
    );
  });
});

describe('sprints, which belong to a Scrum board rather than to the project', () => {
  const boards = { values: [{ id: 3, name: 'PROJ scrum', type: 'scrum' }] };
  const sprints = {
    values: [
      {
        id: 1,
        name: 'Sprint 1',
        state: 'active',
        startDate: '2026-09-01T00:00:00.000Z',
        endDate: '2026-09-14T00:00:00.000Z',
      },
      { id: 2, name: 'Sprint 2', state: 'future' },
      { id: 0, name: 'Sprint 0', state: 'closed' },
    ],
  };

  it("lists the board's sprints as iterations, the active one current", async () => {
    const { t, sent } = transport([{ body: boards }, { body: sprints }]);
    const iterations = await t.listIterations();
    expect(sent[0]?.url).toBe(
      'https://acme.atlassian.net/rest/agile/1.0/board?projectKeyOrId=PROJ&type=scrum',
    );
    expect(sent[1]?.url).toMatch(/\/rest\/agile\/1\.0\/board\/3\/sprint/);
    expect(iterations.map((i) => `${i.name}:${i.current}`)).toEqual([
      'Sprint 1:true',
      'Sprint 2:false',
      'Sprint 0:false',
    ]);
    expect(iterations[0]).toMatchObject({
      id: '1',
      path: 'Sprint 1',
      startDate: '2026-09-01T00:00:00.000Z',
      finishDate: '2026-09-14T00:00:00.000Z',
    });
  });

  it('has no iterations on a project without a Scrum board, and says so on assignment', async () => {
    const { t } = transport([{ body: { values: [] } }]);
    expect(await t.listIterations()).toEqual([]);
    await expect(t.setIteration('PROJ-1', 'Sprint 9')).rejects.toThrow(
      /no sprint 'Sprint 9'.*none/,
    );
  });

  it('moves an issue into a sprint through the agile API, by the path the board answered', async () => {
    const { t, sent } = transport([
      { body: boards },
      { body: sprints },
      { status: 204 },
      {
        body: issue('PROJ-1', 'To Do', {
          [SPRINT_FIELD]: [{ id: 1, name: 'Sprint 1', state: 'active' }],
        }),
      },
    ]);
    const moved = await t.setIteration('PROJ-1', 'Sprint 1');
    const post = sent.find((s) => s.method === 'POST');
    expect(post?.url).toBe('https://acme.atlassian.net/rest/agile/1.0/sprint/1/issue');
    expect(post?.body).toEqual({ issues: ['PROJ-1'] });
    expect(moved.iteration).toBe('Sprint 1');
  });

  it('refuses a sprint the board does not have, naming the ones it does', async () => {
    const { t } = transport([{ body: boards }, { body: sprints }]);
    await expect(t.setIteration('PROJ-1', 'Sprint 7')).rejects.toThrow(
      /no sprint 'Sprint 7'.*Sprint 1, Sprint 2, Sprint 0/,
    );
  });

  it('filters a query by sprint id, not name', async () => {
    const { t, sent } = transport([{ body: boards }, { body: sprints }, { body: { issues: [] } }]);
    await t.queryIssues({ iterationPath: 'Sprint 2' });
    const search = sent.find((s) => s.url.endsWith('/search/jql'));
    expect((search?.body as { jql: string }).jql).toContain('sprint = 2');
  });

  it('reads the sprint an issue is in from the last entry of the sprint field, in either shape', async () => {
    const asObjects = await transport([
      {
        body: issue('PROJ-1', 'To Do', {
          [SPRINT_FIELD]: [
            { id: 0, name: 'Sprint 0', state: 'closed' },
            { id: 1, name: 'Sprint 1', state: 'active' },
          ],
        }),
      },
    ]).t.getIssue('PROJ-1');
    expect(asObjects.iteration).toBe('Sprint 1');
    const asStrings = await transport([
      {
        body: issue('PROJ-1', 'To Do', {
          [SPRINT_FIELD]: [
            'com.atlassian.greenhopper.service.sprint.Sprint@1a[id=1,rapidViewId=3,state=ACTIVE,name=Sprint 1,goal=]',
          ],
        }),
      },
    ]).t.getIssue('PROJ-1');
    expect(asStrings.iteration).toBe('Sprint 1');
    const none = await transport([
      { body: issue('PROJ-1', 'To Do', { [SPRINT_FIELD]: null }) },
    ]).t.getIssue('PROJ-1');
    expect(none.iteration).toBeUndefined();
  });

  it('picks the configured board by id or name', async () => {
    const two = {
      values: [
        { id: 3, name: 'PROJ scrum' },
        { id: 4, name: 'Platform' },
      ],
    };
    const fake = fakeFetch([{ body: two }, { body: sprints }]);
    const t = createJiraTransport({
      site: 'https://acme.atlassian.net',
      email: 'dev@acme.test',
      apiToken: 'tok',
      project: 'PROJ',
      board: 'Platform',
      fetchImpl: fake.fetchImpl,
    });
    await t.listIterations();
    expect(fake.sent[1]?.url).toMatch(/\/board\/4\/sprint/);
  });
});

describe('the Jira transport through the core', () => {
  const adapter = (queue: Array<{ status?: number; body?: unknown }>) => {
    const { t, sent } = transport(queue);
    return {
      port: defineJiraIssuesAdapter(
        { roleMap: exampleJiraRoleMap, typeMap: exampleJiraTypeMap, gapPolicy: {} },
        t,
      ),
      sent,
    };
  };

  it('is refused by the core when the workflow does not reach the mapped status', async () => {
    // One transitions read is all the core needs to refuse; nothing is written.
    const { port, sent } = adapter([
      {
        body: { transitions: [{ id: '21', name: 'Start', to: { id: '3', name: 'In Progress' } }] },
      },
    ]);
    const attempt = port.transition('PROJ-1', 'done');
    await expect(attempt).rejects.toBeInstanceOf(TransitionNotPermittedError);
    await expect(attempt).rejects.toThrow(/permits: In Progress/);
    expect(sent.filter((s) => s.method === 'POST')).toHaveLength(0);
  });

  it('is refused by the core before writing when the screen wants a field it was not given', async () => {
    const resolve = {
      transitions: [
        {
          id: '31',
          name: 'Resolve',
          to: { id: '5', name: 'Done' },
          fields: { resolution: { required: true, allowedValues: [{ name: 'Fixed' }] } },
        },
      ],
    };
    const { port, sent } = adapter([{ body: resolve }, { body: resolve }]);
    const attempt = port.transition('PROJ-1', 'done');
    await expect(attempt).rejects.toBeInstanceOf(TransitionFieldsRequiredError);
    await expect(attempt).rejects.toMatchObject({
      fields: [{ name: 'resolution', required: true, allowedValues: ['Fixed'] }],
    });
    expect(sent.filter((s) => s.method === 'POST')).toHaveLength(0);
  });

  it('performs the transition with the answers once they are supplied', async () => {
    const resolve = {
      transitions: [
        {
          id: '31',
          name: 'Resolve',
          to: { id: '5', name: 'Done' },
          fields: { resolution: { required: true, allowedValues: [{ name: 'Fixed' }] } },
        },
      ],
    };
    const { port, sent } = adapter([
      { body: resolve },
      { body: resolve },
      { body: resolve },
      { status: 204 },
      { body: issue('PROJ-1', 'Done', { labels: [] }) },
    ]);
    const moved = await port.transition('PROJ-1', 'done', {
      fields: { resolution: { name: 'Fixed' } },
    });
    const post = sent.find((s) => s.method === 'POST');
    expect(post?.body).toEqual({
      transition: { id: '31' },
      fields: { resolution: { name: 'Fixed' } },
    });
    expect(moved.role).toBe('done');
  });
});
