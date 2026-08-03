import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub octokit: the conformance suite runs on the in-memory transport, so it cannot see what the
// live adapter actually sends. This asserts the part that was broken in real use — a PR opened with
// no description and no link back to the work item.
const mocks = vi.hoisted(() => ({ create: vi.fn(), getRef: vi.fn(), createRef: vi.fn() }));

vi.mock('octokit', () => ({
  Octokit: vi.fn(() => ({
    rest: {
      pulls: { create: mocks.create },
      git: { getRef: mocks.getRef, createRef: mocks.createRef },
      repos: { get: vi.fn() },
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
