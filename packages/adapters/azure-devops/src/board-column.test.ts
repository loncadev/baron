import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the Azure SDK: the conformance suite proves the core negotiates a column before writing, but
// only a stub of the Work API can show where this transport actually sends it — and a Bug's column
// lives in a different place from a backlog item's.
const mocks = vi.hoisted(() => ({
  getWorkItem: vi.fn(),
  updateWorkItem: vi.fn(),
  getColumns: vi.fn(),
  getTeamIterations: vi.fn(),
  updateWorkItemColumn: vi.fn(),
}));

vi.mock('azure-devops-node-api', () => ({
  WebApi: vi.fn(() => ({
    getWorkItemTrackingApi: async () => ({
      getWorkItem: mocks.getWorkItem,
      updateWorkItem: mocks.updateWorkItem,
    }),
    getWorkApi: async () => ({
      getColumns: mocks.getColumns,
      getTeamIterations: mocks.getTeamIterations,
      updateWorkItemColumn: mocks.updateWorkItemColumn,
    }),
  })),
  getPersonalAccessTokenHandler: vi.fn(() => ({})),
}));

const { createAzureDevOpsTransport } = await import('./transport.js');

const transport = () =>
  createAzureDevOpsTransport({ organization: 'org', project: 'Proj', token: 'x' });

const item = (fields: Record<string, unknown>) => ({
  id: 7,
  fields: { 'System.Id': 7, ...fields },
});
const bugOnSprint = item({
  'System.WorkItemType': 'Bug',
  'System.State': 'Active',
  'System.IterationPath': 'Proj\\Sprint 5',
});

/** Beetegre-V2's Taskboard, as `taskboardcolumns` returned it on 2026-08-05. */
const TASKBOARD = {
  columns: [
    { id: 'c1', name: 'Active', mappings: [{ workItemType: 'Bug', state: 'Active' }] },
    { id: 'c2', name: 'Test', mappings: [{ workItemType: 'Bug', state: 'Test' }] },
    { id: 'c3', name: 'Failed Test', mappings: [{ workItemType: 'Bug', state: 'Active' }] },
    { id: 'c4', name: 'Waiting for Release', mappings: [{ workItemType: 'Bug', state: 'Test' }] },
  ],
};

describe('azure board column', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getColumns.mockResolvedValue(TASKBOARD);
    mocks.getTeamIterations.mockResolvedValue([
      { id: 'iter-5', name: 'Sprint 5', path: 'Proj\\Sprint 5' },
    ]);
    mocks.updateWorkItem.mockImplementation(async () => bugOnSprint);
  });

  it("writes a backlog item's column through its Kanban field, in the same patch as the state", async () => {
    const pbi = item({
      'System.WorkItemType': 'Product Backlog Item',
      'WEF_ABC_Kanban.Column': 'New',
    });
    mocks.getWorkItem.mockResolvedValue(pbi);
    mocks.updateWorkItem.mockResolvedValue(pbi);
    await transport().applyTarget('7', { state: 'Active', boardColumn: 'Active' });

    const ops = mocks.updateWorkItem.mock.calls[0]?.[1] as Array<{ path: string; value: string }>;
    expect(ops.map((op) => op.path)).toEqual([
      '/fields/System.State',
      '/fields/WEF_ABC_Kanban.Column',
    ]);
    expect(mocks.updateWorkItemColumn).not.toHaveBeenCalled();
  });

  it("writes a Bug's column on the team's Taskboard, after the state, in the item's own sprint", async () => {
    mocks.getWorkItem.mockResolvedValue(bugOnSprint);
    await transport().applyTarget('7', { state: 'Test', boardColumn: 'waiting for release' });

    const ops = mocks.updateWorkItem.mock.calls[0]?.[1] as Array<{ path: string }>;
    expect(ops.map((op) => op.path)).toEqual(['/fields/System.State']);
    // The column's own name (not the caller's casing), the team context, the item's sprint.
    expect(mocks.updateWorkItemColumn).toHaveBeenCalledWith(
      { newColumn: 'Waiting for Release' },
      { project: 'Proj', team: 'Proj Team' },
      'iter-5',
      7,
    );
    expect(mocks.updateWorkItem.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updateWorkItemColumn.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('finds the sprint by its leaf name when the paths differ in their root', async () => {
    mocks.getWorkItem.mockResolvedValue(bugOnSprint);
    mocks.getTeamIterations.mockResolvedValue([
      { id: 'iter-5', name: 'Sprint 5', path: 'Proj\\Iteration\\Sprint 5' },
    ]);
    expect(
      await transport().boardColumnUnreachable?.('7', { state: 'Test', boardColumn: 'Test' }),
    ).toBeUndefined();
  });

  // Measured on BeeMaster (2026-10-06): an uncustomized Taskboard reports no columns at all, because
  // its columns are simply the states.
  describe('an uncustomized Taskboard', () => {
    beforeEach(() => {
      mocks.getWorkItem.mockResolvedValue(bugOnSprint);
      mocks.getColumns.mockResolvedValue({ isCustomized: false, isValid: true, columns: [] });
    });

    it('takes a column named like the target state, and the state write alone places the card', async () => {
      const target = { state: 'Active', boardColumn: 'active' };
      expect(await transport().boardColumnUnreachable?.('7', target)).toBeUndefined();
      await transport().applyTarget('7', target);
      const ops = mocks.updateWorkItem.mock.calls[0]?.[1] as Array<{ path: string }>;
      expect(ops.map((op) => op.path)).toEqual(['/fields/System.State']);
      expect(mocks.updateWorkItemColumn).not.toHaveBeenCalled();
    });

    it('cannot take any other column', async () => {
      expect(
        await transport().boardColumnUnreachable?.('7', {
          state: 'Active',
          boardColumn: 'In Progress',
        }),
      ).toMatch(/not customized, so its columns are the states/);
    });
  });

  describe('says why a column is out of reach, so the core can apply the gap policy', () => {
    const reasonFor = async (target: Record<string, string>) => {
      mocks.getWorkItem.mockResolvedValue(bugOnSprint);
      return transport().boardColumnUnreachable?.('7', target);
    };

    it('a column the Taskboard does not have', async () => {
      expect(await reasonFor({ state: 'Test', boardColumn: 'Shipped' })).toMatch(
        /no column 'Shipped' \(it has: Active, Test, Failed Test, Waiting for Release\)/,
      );
    });

    it('a column that does not take this type', async () => {
      mocks.getColumns.mockResolvedValue({
        columns: [{ name: 'Test', mappings: [{ workItemType: 'Task', state: 'Test' }] }],
      });
      expect(await reasonFor({ state: 'Test', boardColumn: 'Test' })).toMatch(
        /does not take Bug items/,
      );
    });

    it('a column whose own state mapping disagrees with the target state', async () => {
      // Writing "Failed Test" sets the state its mapping names — Active — so pairing it with Test
      // would land the item somewhere nobody asked for.
      expect(await reasonFor({ state: 'Test', boardColumn: 'Failed Test' })).toMatch(
        /holds Bug items in state 'Active', but the role map pairs it with 'Test'/,
      );
    });

    it("an item on none of the team's sprints", async () => {
      mocks.getTeamIterations.mockResolvedValue([
        { id: 'iter-6', name: 'Sprint 6', path: 'Proj\\Sprint 6' },
      ]);
      expect(await reasonFor({ state: 'Test', boardColumn: 'Test' })).toMatch(
        /iteration 'Proj\\Sprint 5' is not one of team 'Proj Team''s sprints/,
      );
    });

    it('and nothing at all when the target carries no column', async () => {
      expect(await reasonFor({ state: 'Test' })).toBeUndefined();
      expect(mocks.getColumns).not.toHaveBeenCalled();
    });
  });

  it('refuses loudly rather than dropping a column the item cannot take', async () => {
    mocks.getWorkItem.mockResolvedValue(bugOnSprint);
    await expect(
      transport().applyTarget('7', { state: 'Test', boardColumn: 'Shipped' }),
    ).rejects.toThrow(/Cannot write board column 'Shipped' on 7/);
    expect(mocks.updateWorkItem).not.toHaveBeenCalled();
  });
});
