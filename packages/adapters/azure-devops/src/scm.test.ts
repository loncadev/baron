import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the Azure SDK: like the GitHub counterpart, this covers what the conformance suite (in-memory)
// structurally cannot — the description the live adapter actually sends, including the native
// work-item mention that makes Azure associate the PR with the item.
const mocks = vi.hoisted(() => ({
  createPullRequest: vi.fn(),
  getPullRequestById: vi.fn(),
  updatePullRequest: vi.fn(),
  getPolicyEvaluations: vi.fn(),
}));

vi.mock('azure-devops-node-api', () => ({
  WebApi: vi.fn(() => ({
    getGitApi: async () => ({
      createPullRequest: mocks.createPullRequest,
      getPullRequestById: mocks.getPullRequestById,
      updatePullRequest: mocks.updatePullRequest,
    }),
    getPolicyApi: async () => ({ getPolicyEvaluations: mocks.getPolicyEvaluations }),
  })),
  getPersonalAccessTokenHandler: vi.fn(() => ({})),
}));

import { PolicyEvaluationStatus } from 'azure-devops-node-api/interfaces/PolicyInterfaces.js';

const { createAzureDevOpsScmTransport } = await import('./scm.js');

function transport() {
  return createAzureDevOpsScmTransport({
    organization: 'org',
    project: 'proj',
    repository: 'repo',
    token: 'x',
  });
}

describe('azure scm createPullRequest', () => {
  // Each case inspects calls[0], so recorded calls must not carry over between tests.
  beforeEach(() => vi.clearAllMocks());

  it("links the work item with Azure's AB# mention and keeps the description", async () => {
    mocks.createPullRequest.mockResolvedValue({ pullRequestId: 9, title: 't', isDraft: true });
    await transport().createPullRequest({
      title: 't',
      body: 'What changed and why.',
      sourceBranch: 'bug/1488-x',
      targetBranch: 'dev',
      draft: true,
      linkedIssueKey: '1488',
    });

    const description = mocks.createPullRequest.mock.calls[0]?.[0]?.description as string;
    expect(description).toContain('What changed and why.');
    expect(description).toContain('AB#1488');
  });

  it('omits the description entirely when there is nothing to say', async () => {
    mocks.createPullRequest.mockResolvedValue({ pullRequestId: 10, title: 't', isDraft: true });
    await transport().createPullRequest({
      title: 't',
      sourceBranch: 's',
      targetBranch: 'dev',
      draft: true,
    });
    expect(mocks.createPullRequest.mock.calls[0]?.[0]?.description).toBeUndefined();
  });
});

/**
 * Azure's PR "checks" are branch-policy evaluations on a separate API, and for a long time this
 * adapter did not read them: every rollup came back `unknown`, so task-land's never-land-red guard
 * had nothing to look at on Azure and every land there passed through a warning instead of a gate.
 *
 * The status values are the SDK's enum, verified against a live project through Baron's own escape
 * hatch — the API is preview-only (`7.1-preview.1`), which no amount of reading the types tells you.
 */
describe('azure scm branch-policy evaluations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPullRequestById.mockResolvedValue({
      pullRequestId: 9,
      status: 1,
      reviewers: [],
      repository: { project: { id: 'project-guid' } },
    });
  });

  const evaluation = (status: number, isEnabled = true) => ({
    status,
    configuration: { isEnabled, isBlocking: true },
  });

  it('counts an approved policy as a passing check', async () => {
    mocks.getPolicyEvaluations.mockResolvedValue([evaluation(PolicyEvaluationStatus.Approved)]);
    const status = await transport().getPullRequestStatus('9');
    expect(status.checks.rollup).toBe('succeeded');
    expect(status.checks.total).toBe(1);
    expect(status.checks.succeeded).toBe(1);
    // The artifact id must carry the project GUID: a project NAME returns an empty list rather than
    // an error, which would read as "no policies" — the exact false green this path exists to avoid.
    expect(mocks.getPolicyEvaluations.mock.calls[0]?.[1]).toContain('project-guid');
  });

  it('goes red on a rejected policy and on a broken one', async () => {
    for (const status of [PolicyEvaluationStatus.Rejected, PolicyEvaluationStatus.Broken]) {
      mocks.getPolicyEvaluations.mockResolvedValue([evaluation(status)]);
      const result = await transport().getPullRequestStatus('9');
      expect(result.checks.rollup, `status ${status}`).toBe('failed');
      expect(result.checks.failed).toBe(1);
    }
  });

  it('is pending while a policy is queued or running', async () => {
    mocks.getPolicyEvaluations.mockResolvedValue([
      evaluation(PolicyEvaluationStatus.Approved),
      evaluation(PolicyEvaluationStatus.Running),
    ]);
    const status = await transport().getPullRequestStatus('9');
    expect(status.checks.rollup).toBe('pending');
    expect(status.checks.pending).toBe(1);
  });

  it('ignores a policy that is switched off', async () => {
    mocks.getPolicyEvaluations.mockResolvedValue([
      evaluation(PolicyEvaluationStatus.Rejected, false),
    ]);
    const status = await transport().getPullRequestStatus('9');
    // A disabled policy cannot block a merge, so counting it would stop a land nothing is stopping.
    expect(status.checks.rollup).toBe('none');
    expect(status.checks.total).toBe(0);
  });

  it("says 'none' when the repository has no policies, which is not the same as not looking", async () => {
    mocks.getPolicyEvaluations.mockResolvedValue([]);
    const status = await transport().getPullRequestStatus('9');
    expect(status.checks.rollup).toBe('none');
    expect(status.checks.unreadable).toBeUndefined();
  });

  it("says 'unknown' with a remedy when the policies cannot be read at all", async () => {
    mocks.getPolicyEvaluations.mockRejectedValue(new Error('403 Forbidden'));
    const status = await transport().getPullRequestStatus('9');
    // Never 'none' on a failure: that would tell a caller the merge is unblocked by CI when Baron
    // simply could not look — the false green the whole summary is shaped to prevent.
    expect(status.checks.rollup).toBe('unknown');
    expect(status.checks.unreadable).toEqual(['policy-evaluations']);
    expect(status.checks.remedy).toContain('403 Forbidden');
  });
});

describe('azure scm mergePullRequest', () => {
  beforeEach(() => vi.clearAllMocks());

  const ACTIVE = 1;
  const ABANDONED = 2;
  const COMPLETED = 3;

  function patient() {
    const waits: number[] = [];
    const t = createAzureDevOpsScmTransport({
      organization: 'org',
      project: 'proj',
      repository: 'repo',
      token: 'x',
      completionTimeoutMs: 5000,
      completionPollMs: 1000,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    return { t, waits };
  }

  it('waits for Azure to finish completing the PR instead of judging the PATCH response', async () => {
    // Found live: the completion PATCH answers with the PR still Active (status 1) and the merge
    // lands about 1.6 s later. Reading the answer as the verdict reported a real merge as failed.
    mocks.getPullRequestById
      .mockResolvedValueOnce({ status: ACTIVE, lastMergeSourceCommit: { commitId: 'src' } })
      .mockResolvedValueOnce({ status: ACTIVE })
      .mockResolvedValueOnce({ status: COMPLETED, lastMergeCommit: { commitId: 'merged-sha' } });
    mocks.updatePullRequest.mockResolvedValue({ status: ACTIVE });
    const { t, waits } = patient();
    const result = await t.mergePullRequest('2436', {
      strategy: 'squash',
      deleteSourceBranch: true,
    });
    expect(result).toEqual({ pullRequestId: '2436', sha: 'merged-sha' });
    expect(waits).toEqual([1000, 1000]);
    // One read before the PATCH (for the source commit), two while waiting.
    expect(mocks.getPullRequestById).toHaveBeenCalledTimes(3);
  });

  it('returns at once when the PATCH already reports Completed', async () => {
    mocks.getPullRequestById.mockResolvedValueOnce({ status: ACTIVE });
    mocks.updatePullRequest.mockResolvedValue({
      status: COMPLETED,
      lastMergeCommit: { commitId: 'now' },
    });
    const { t, waits } = patient();
    expect(await t.mergePullRequest('1', {})).toEqual({ pullRequestId: '1', sha: 'now' });
    expect(waits).toEqual([]);
  });

  it('gives up after the bounded wait, naming how long it waited and what to do', async () => {
    mocks.getPullRequestById.mockResolvedValue({ status: ACTIVE });
    mocks.updatePullRequest.mockResolvedValue({ status: ACTIVE });
    const t = createAzureDevOpsScmTransport({
      organization: 'org',
      project: 'proj',
      repository: 'repo',
      token: 'x',
      completionTimeoutMs: 0,
      sleep: async () => {},
    });
    await expect(t.mergePullRequest('7', {})).rejects.toMatchObject({
      code: 'MERGE_FAILED',
      message: expect.stringMatching(
        /has not completed PR 7 after 0 s .*read the PR status before retrying/,
      ),
    });
  });

  it('reports an abandoned PR as a failed merge', async () => {
    mocks.getPullRequestById
      .mockResolvedValueOnce({ status: ACTIVE })
      .mockResolvedValueOnce({ status: ABANDONED });
    mocks.updatePullRequest.mockResolvedValue({ status: ACTIVE });
    const { t } = patient();
    await expect(t.mergePullRequest('9', {})).rejects.toMatchObject({
      code: 'MERGE_FAILED',
      message: expect.stringMatching(/abandoned PR 9/),
    });
  });
});
