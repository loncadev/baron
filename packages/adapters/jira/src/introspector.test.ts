import { describe, expect, it } from 'vitest';
import { createJiraIntrospector } from './introspector.js';

const projectStatuses = [
  {
    id: '10001',
    name: 'Story',
    subtask: false,
    statuses: [
      { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
      { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      { id: '4', name: 'In Review', statusCategory: { key: 'indeterminate' } },
      { id: '5', name: 'Done', statusCategory: { key: 'done' } },
    ],
  },
  {
    id: '10003',
    name: 'Sub-task',
    subtask: true,
    // A workflow shared with Story: the same names again, plus one of its own with no category.
    statuses: [
      { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
      { id: '5', name: 'Done', statusCategory: { key: 'done' } },
      { id: '9', name: 'Parked' },
    ],
  },
];

function introspector(status: number, body: unknown) {
  const sent: string[] = [];
  const fetchImpl = (async (url: string) => {
    sent.push(url);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }) as unknown as typeof fetch;
  return {
    sent,
    introspector: createJiraIntrospector({
      site: 'https://acme.atlassian.net',
      email: 'dev@acme.test',
      apiToken: 'tok',
      project: 'PROJ',
      fetchImpl,
    }),
  };
}

describe('the Jira introspector', () => {
  it('reads types and statuses from one project-statuses call, keyed by status name', async () => {
    const { introspector: i, sent } = introspector(200, projectStatuses);
    const result = await i.introspect();
    expect(sent[0]).toBe('https://acme.atlassian.net/rest/api/2/project/PROJ/statuses');
    expect(result.stateKey).toBe('status');
    expect(result.workItemTypes).toEqual([
      { name: 'Story', hierarchyLevel: 0 },
      { name: 'Sub-task', hierarchyLevel: 1 },
    ]);
    // De-duplicated across types and ordered by category (To Do, In Progress, Done, then the
    // uncategorised), stable within a category; a status with no category is `unknown` for a
    // human to place rather than guessed.
    expect(result.states).toEqual([
      { name: 'To Do', category: 'proposed' },
      { name: 'In Progress', category: 'in_progress' },
      { name: 'In Review', category: 'in_progress' },
      { name: 'Done', category: 'completed' },
      { name: 'Parked', category: 'unknown' },
    ]);
  });

  it('orders statuses by category however Jira lists them', async () => {
    const shuffled = [
      {
        ...projectStatuses[0],
        statuses: [
          { id: '4', name: 'In Review', statusCategory: { key: 'indeterminate' } },
          { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
          { id: '5', name: 'Done', statusCategory: { key: 'done' } },
          { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
        ],
      },
    ];
    const { introspector: i } = introspector(200, shuffled);
    expect((await i.introspect()).states.map((s) => s.name)).toEqual([
      'To Do',
      'In Review',
      'In Progress',
      'Done',
    ]);
  });

  it('fails loudly on a project it cannot read', async () => {
    const { introspector: i } = introspector(404, {});
    await expect(i.introspect()).rejects.toThrow(/HTTP 404 reading project 'PROJ'/);
  });
});
