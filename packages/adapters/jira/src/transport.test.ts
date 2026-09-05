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

function fakeFetch(queue: Array<{ status?: number; body?: unknown }>) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    sent.push({
      method: init?.method ?? 'GET',
      url,
      headers: (init?.headers as Record<string, string>) ?? {},
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
    });
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
    expect(sent[0]?.url).toBe(
      'https://acme.atlassian.net/rest/api/2/issue/PROJ-1?fields=summary,description,status,issuetype,parent,labels,assignee',
    );
    expect(sent[0]?.headers.authorization).toBe(
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
    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.url).toMatch(/\/search\/jql$/);
    expect(sent[0]?.body).toMatchObject({
      jql: 'project = "PROJ" AND status in ("In Progress", "In Review") AND issuetype = "Bug" AND assignee = currentUser() ORDER BY updated DESC',
      maxResults: 7,
    });
  });

  it('escapes a status name that would otherwise break out of its JQL literal', async () => {
    const { t, sent } = transport([{ body: { issues: [] } }]);
    await t.queryIssues({ targets: [{ [JIRA_STATE_KEY]: 'Won\'t "Do" \\ ever' }] });
    expect((sent[0]?.body as { jql: string }).jql).toContain(
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
