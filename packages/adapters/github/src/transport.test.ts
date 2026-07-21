import { describe, expect, it, vi } from 'vitest';

// Stub octokit so we can assert the real transport's @me handling without a network — the conformance
// suite runs on the in-memory transport and so cannot catch a bug in the live octokit path (this one:
// GitHub's assignIssue used to send the literal '@me' as a login, which GitHub rejects).
const mocks = vi.hoisted(() => ({ update: vi.fn(), getAuthenticated: vi.fn() }));

vi.mock('octokit', () => ({
  Octokit: vi.fn(() => ({
    rest: {
      issues: { update: mocks.update },
      users: { getAuthenticated: mocks.getAuthenticated },
    },
  })),
}));

const { createGithubTransport } = await import('./transport.js');

describe('github transport @me assignment', () => {
  it("resolves '@me' to the token owner's login, never assigning the literal '@me'", async () => {
    mocks.getAuthenticated.mockResolvedValue({ data: { login: 'octocat' } });
    mocks.update.mockResolvedValue({
      data: {
        number: 5,
        title: 't',
        state: 'open',
        labels: [],
        assignee: { login: 'octocat' },
        html_url: 'https://example.test/5',
      },
    });

    const transport = createGithubTransport({ owner: 'o', repo: 'r', token: 'x' });
    const issue = await transport.assignIssue('5', '@me');

    // The bug: assignees: ['@me']. The fix resolves it to the authenticated login first.
    expect(mocks.getAuthenticated).toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ assignees: ['octocat'] }));
    expect(issue.assignee).toBe('octocat');
  });
});
