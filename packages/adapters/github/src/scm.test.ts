import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub octokit: the conformance suite runs on the in-memory transport, so it cannot see what the
// live adapter actually sends. This asserts the part that was broken in real use — a PR opened with
// no description and no link back to the work item.
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  getRef: vi.fn(),
  createRef: vi.fn(),
  prGet: vi.fn(),
  listReviews: vi.fn(),
  checksListForRef: vi.fn(),
  listWorkflowRuns: vi.fn(),
  combinedStatus: vi.fn(),
}));

vi.mock('octokit', () => ({
  Octokit: vi.fn(() => ({
    // The real client carries hooks, and the transport installs a permission-error hook on it.
    hook: { error: vi.fn() },
    rest: {
      pulls: { create: mocks.create, get: mocks.prGet, listReviews: mocks.listReviews },
      git: { getRef: mocks.getRef, createRef: mocks.createRef },
      checks: { listForRef: mocks.checksListForRef },
      actions: { listWorkflowRunsForRepo: mocks.listWorkflowRuns },
      repos: { get: vi.fn(), getCombinedStatusForRef: mocks.combinedStatus },
    },
  })),
}));

const { createGithubScmTransport } = await import('./scm.js');

function transport() {
  return createGithubScmTransport({ owner: 'o', repo: 'r', token: 'x' });
}

const CREATED_PR = {
  data: {
    number: 5,
    title: 'fix: something',
    html_url: 'https://example.test/pull/5',
    draft: true,
  },
};

describe('github scm createPullRequest', () => {
  // Each case inspects calls[0], so the recorded calls must not carry over between tests.
  beforeEach(() => vi.clearAllMocks());

  it("links the work item with GitHub's closing keyword and keeps the description", async () => {
    mocks.create.mockResolvedValue(CREATED_PR);
    await transport().createPullRequest({
      title: 'fix: something',
      body: 'What changed and why.',
      sourceBranch: 'bug/3-x',
      targetBranch: 'main',
      draft: true,
      linkedIssueKey: '3',
    });

    const body = mocks.create.mock.calls[0]?.[0]?.body as string;
    // The description survives, and the native keyword is appended — that keyword (not the comment
    // the recipe posts) is what makes GitHub show the PR in the issue and close it on merge.
    expect(body).toContain('What changed and why.');
    expect(body).toContain('Closes #3');
  });

  it('accepts an issue key that already carries the # and does not double it', async () => {
    mocks.create.mockResolvedValue(CREATED_PR);
    await transport().createPullRequest({
      title: 't',
      sourceBranch: 's',
      targetBranch: 'main',
      draft: true,
      linkedIssueKey: '#7',
    });
    expect(mocks.create.mock.calls[0]?.[0]?.body).toBe('Closes #7');
  });

  it('sends no body when there is neither a description nor a linked item', async () => {
    mocks.create.mockResolvedValue(CREATED_PR);
    await transport().createPullRequest({
      title: 't',
      sourceBranch: 's',
      targetBranch: 'main',
      draft: true,
    });
    expect(mocks.create.mock.calls[0]?.[0]?.body).toBeUndefined();
  });
});

/** A GitHub permission refusal, as octokit surfaces it. */
function forbidden(): Error & { status: number } {
  return Object.assign(new Error('Resource not accessible by personal access token'), {
    status: 403,
  });
}

const OPEN_PR = {
  data: {
    number: 7,
    state: 'open',
    merged: false,
    mergeable: true,
    head: { sha: 'abc123' },
    html_url: 'https://example.test/pull/7',
  },
};

describe('github scm prStatus when the credential cannot read checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prGet.mockResolvedValue(OPEN_PR);
    mocks.listReviews.mockResolvedValue({ data: [] });
  });

  it('falls back to Actions + commit statuses, which a fine-grained token CAN be granted', async () => {
    // "Checks" is not among the permissions a fine-grained PAT can hold at all, so this 403 is the
    // normal case for a human's token — not an edge case.
    mocks.checksListForRef.mockRejectedValue(forbidden());
    mocks.listWorkflowRuns.mockResolvedValue({
      data: { workflow_runs: [{ status: 'completed', conclusion: 'failure' }] },
    });
    mocks.combinedStatus.mockResolvedValue({ data: { statuses: [] } });

    const status = await transport().getPullRequestStatus('7');
    expect(status.checks.rollup).toBe('failed');
    expect(status.checks.failed).toBe(1);
  });

  it("reports 'unknown' — never 'none' — when nothing is readable", async () => {
    mocks.checksListForRef.mockRejectedValue(forbidden());
    mocks.listWorkflowRuns.mockRejectedValue(forbidden());
    mocks.combinedStatus.mockRejectedValue(forbidden());

    const status = await transport().getPullRequestStatus('7');
    // 'none' would mean "asked, and there is no CI" — a green light to merge. Baron never looked.
    expect(status.checks.rollup).toBe('unknown');
    expect(status.checks.total).toBe(0);
    // One missing permission must not blind the whole call: what the token CAN read still comes back.
    expect(status.state).toBe('open');
    expect(status.mergeable).toBe(true);
  });

  it("reports 'none' when checks ARE readable and there genuinely are none", async () => {
    mocks.checksListForRef.mockResolvedValue({ data: { check_runs: [] } });

    const status = await transport().getPullRequestStatus('7');
    expect(status.checks.rollup).toBe('none');
    expect(mocks.listWorkflowRuns).not.toHaveBeenCalled(); // no needless fallback
  });

  it("a readable-but-empty commit-status view must NOT be read as 'none'", async () => {
    // The false green this whole path exists to prevent. GitHub Actions never writes legacy commit
    // statuses, so reading that API successfully and finding it empty proves nothing about whether a
    // workflow is red. A token holding Commit statuses but not Actions used to land here and get
    // 'none' — "no CI, safe to merge" — while a workflow was failing.
    mocks.checksListForRef.mockRejectedValue(forbidden());
    mocks.listWorkflowRuns.mockRejectedValue(forbidden());
    mocks.combinedStatus.mockResolvedValue({ data: { statuses: [] } });

    const status = await transport().getPullRequestStatus('7');
    expect(status.checks.rollup).toBe('unknown');
    expect(status.checks.rollup).not.toBe('none');
    // And it names WHY, so an unexplained 'unknown' is not mistaken for a broken integration.
    expect(status.checks.unreadable).toEqual(['check-runs', 'actions-runs']);
  });

  it('a definite failure stays definite even when the view is partial', async () => {
    mocks.checksListForRef.mockRejectedValue(forbidden());
    mocks.listWorkflowRuns.mockRejectedValue(forbidden());
    mocks.combinedStatus.mockResolvedValue({ data: { statuses: [{ state: 'failure' }] } });

    const status = await transport().getPullRequestStatus('7');
    expect(status.checks.rollup).toBe('failed');
  });

  it('reports a green check run as succeeded when check-runs IS readable', async () => {
    // Guards the happy path: a credential that can read check runs must see them, not fall through.
    mocks.checksListForRef.mockResolvedValue({
      data: { check_runs: [{ status: 'completed', conclusion: 'success' }] },
    });

    const status = await transport().getPullRequestStatus('7');
    expect(status.checks.rollup).toBe('succeeded');
    expect(status.checks.total).toBe(1);
    expect(status.checks.unreadable).toBeUndefined();
  });

  it('surfaces a non-permission failure instead of swallowing it as unknown', async () => {
    mocks.checksListForRef.mockRejectedValue(
      Object.assign(new Error('server error'), { status: 500 }),
    );
    await expect(transport().getPullRequestStatus('7')).rejects.toThrow('server error');
  });
});
