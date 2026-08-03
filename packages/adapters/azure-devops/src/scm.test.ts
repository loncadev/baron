import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the Azure SDK: like the GitHub counterpart, this covers what the conformance suite (in-memory)
// structurally cannot — the description the live adapter actually sends, including the native
// work-item mention that makes Azure associate the PR with the item.
const mocks = vi.hoisted(() => ({ createPullRequest: vi.fn() }));

vi.mock('azure-devops-node-api', () => ({
  WebApi: vi.fn(() => ({
    getGitApi: async () => ({ createPullRequest: mocks.createPullRequest }),
  })),
  getPersonalAccessTokenHandler: vi.fn(() => ({})),
}));

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
