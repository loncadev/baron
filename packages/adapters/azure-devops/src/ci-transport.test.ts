import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the Azure SDK: the conformance suite runs on the in-memory transport and cannot see what the
// live adapter asks Azure for — which is exactly where the branch filter went missing.
const mocks = vi.hoisted(() => ({
  getBuilds: vi.fn(),
}));

vi.mock('azure-devops-node-api', () => ({
  WebApi: vi.fn(() => ({
    getBuildApi: async () => ({ getBuilds: mocks.getBuilds }),
  })),
  getPersonalAccessTokenHandler: vi.fn(() => ({})),
}));

const { createAzureDevOpsCiTransport } = await import('./ci.js');

const transport = () =>
  createAzureDevOpsCiTransport({ organization: 'org', project: 'proj', token: 'x' });

describe('azure ci listRuns', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks Azure for the branch, newest queued first, instead of filtering a window afterwards', async () => {
    // Found live: filtering client-side spent `top` on other branches' builds, so a build queued a
    // moment ago on the asked-for branch was invisible — the same query returned nothing at limit 5
    // and the build at limit 50.
    mocks.getBuilds.mockResolvedValue([
      { id: 4681, status: 32, sourceBranch: 'refs/heads/task/2003-x', definition: { id: 59 } },
    ]);
    const runs = await transport().listRuns({ branch: 'task/2003-x', limit: 5 });
    expect(runs.map((r) => r.id)).toEqual(['4681']);

    const args = mocks.getBuilds.mock.calls[0] as unknown[];
    expect(args[0]).toBe('proj');
    expect(args[12]).toBe(5); // top
    expect(args[16]).toBe(4); // BuildQueryOrder.QueueTimeDescending
    expect(args[17]).toBe('refs/heads/task/2003-x'); // branchName, the server-side filter
  });

  it('passes no branch when none was asked for, and keeps the queue-time order', async () => {
    mocks.getBuilds.mockResolvedValue([]);
    await transport().listRuns({ limit: 3 });
    const args = mocks.getBuilds.mock.calls[0] as unknown[];
    expect(args[12]).toBe(3);
    expect(args[16]).toBe(4);
    expect(args[17]).toBeUndefined();
  });
});
