import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub octokit so we can assert the real transport's @me handling without a network — the conformance
// suite runs on the in-memory transport and so cannot catch a bug in the live octokit path (this one:
// GitHub's assignIssue used to send the literal '@me' as a login, which GitHub rejects).
const mocks = vi.hoisted(() => ({
  addLabels: vi.fn(),
  update: vi.fn(),
  getAuthenticated: vi.fn(),
  get: vi.fn(),
}));

vi.mock('octokit', () => ({
  Octokit: vi.fn(() => ({
    // The real client carries hooks; the factory installs a version hook and, for a bound port,
    // a permission-error hook on it.
    hook: { before: vi.fn(), error: vi.fn() },
    rest: {
      issues: { update: mocks.update, get: mocks.get, addLabels: mocks.addLabels },
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

describe('github transport native type', () => {
  const issue = (type?: unknown) => ({
    data: {
      number: 7,
      title: 't',
      state: 'open',
      labels: [],
      html_url: 'https://example.test/7',
      ...(type === undefined ? {} : { type }),
    },
  });

  it("reports the repo's Issue Type when one is assigned", async () => {
    mocks.get.mockResolvedValue(issue({ name: 'Bug' }));
    const transport = createGithubTransport({ owner: 'acme', repo: 'store', token: 't' });

    expect((await transport.getIssue('7')).nativeType).toBe('Bug');
  });

  it("falls back to 'issue' when no Issue Type is set", async () => {
    // Every issue in a repo that has not adopted Issue Types — and, before this was read at all,
    // every issue everywhere, which is what made a policy mapping roles onto Task/Bug/Feature
    // unusable.
    for (const absent of [undefined, null, { name: '' }, {}]) {
      mocks.get.mockResolvedValue(issue(absent));
      const transport = createGithubTransport({ owner: 'acme', repo: 'store', token: 't' });

      expect((await transport.getIssue('7')).nativeType).toBe('issue');
    }
  });
});

// A role that pins no native state must not leave a terminal one in place. Only `done` pins 'closed'
// on GitHub, so moving a closed item anywhere else IS a reopen — and without it the label said
// in_progress while GitHub said closed, which is the exact drift `reconcile` treats as authoritative:
// it would clear the new label and put `done` back, undoing the move. The conformance suite cannot
// see this — the memory transport has no separate closed concept.
describe('github applyTarget reopening', () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset();
  });

  const issue = (state: string) => ({
    data: { number: 7, title: 't', state, labels: [], body: null, assignee: null },
  });

  it('reopens a closed item when the target pins no state', async () => {
    mocks.get.mockResolvedValue(issue('closed'));
    mocks.addLabels.mockResolvedValue({ data: {} });
    mocks.update.mockResolvedValue({ data: {} });

    await createGithubTransport({ owner: 'o', repo: 'r', token: 'x' }).applyTarget('7', {
      label: 'in-progress',
    });

    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 7, state: 'open', state_reason: 'reopened' }),
    );
  });

  it('leaves an already-open item alone — a move between open roles costs no state write', async () => {
    mocks.get.mockResolvedValue(issue('open'));
    mocks.addLabels.mockResolvedValue({ data: {} });

    await createGithubTransport({ owner: 'o', repo: 'r', token: 'x' }).applyTarget('7', {
      label: 'in-review',
    });

    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('still closes when the target pins closed', async () => {
    mocks.get.mockResolvedValue(issue('open'));
    mocks.addLabels.mockResolvedValue({ data: {} });
    mocks.update.mockResolvedValue({ data: {} });

    await createGithubTransport({ owner: 'o', repo: 'r', token: 'x' }).applyTarget('7', {
      label: 'done',
      state: 'closed',
    });

    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'closed', state_reason: 'completed' }),
    );
  });
});
