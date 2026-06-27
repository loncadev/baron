import { describe, expect, it } from 'vitest';
import { CapabilityGapError } from './errors.js';
import { RecordingLogger } from './logger.js';
import { BaseScmAdapter, type ScmManifest, type ScmTransport } from './scm.js';

const transport: ScmTransport = {
  async createBranch(name: string) {
    return { name, sha: 'sha1' };
  },
  async createPullRequest(input) {
    return {
      id: 'pr1',
      title: input.title,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      draft: input.draft,
    };
  },
  async addPullRequestThread() {
    return { id: 'thread1' };
  },
};

const noDraft: ScmManifest = {
  provider: 'fake',
  scm: { draftPullRequests: false, pullRequestThreads: true },
};
const withDraft: ScmManifest = {
  provider: 'fake',
  scm: { draftPullRequests: true, pullRequestThreads: true },
};

const prDraft = {
  title: 'x',
  sourceBranch: 'feature/x',
  targetBranch: 'main',
  draft: true,
} as const;

describe('BaseScmAdapter draft-PR gap', () => {
  it('opens a draft PR when the provider supports it', async () => {
    const adapter = new BaseScmAdapter(withDraft, transport);
    const pr = await adapter.createPullRequest(prDraft);
    expect(pr.draft).toBe(true);
  });

  it('degrades to a non-draft PR and warns when draft is unsupported', async () => {
    const log = new RecordingLogger();
    const adapter = new BaseScmAdapter(
      noDraft,
      transport,
      { draftPullRequests: { kind: 'degrade' } },
      log,
    );
    const pr = await adapter.createPullRequest(prDraft);
    expect(pr.draft).toBe(false);
    expect(log.entries.some((e) => e.level === 'warn')).toBe(true);
  });

  it('errors on a draft PR under the strict default policy (never silent)', async () => {
    const adapter = new BaseScmAdapter(noDraft, transport);
    await expect(adapter.createPullRequest(prDraft)).rejects.toBeInstanceOf(CapabilityGapError);
  });

  it('opens a ready PR without invoking the gap', async () => {
    const adapter = new BaseScmAdapter(noDraft, transport);
    const pr = await adapter.createPullRequest({ ...prDraft, draft: false });
    expect(pr.draft).toBe(false);
  });
});

const noThreads: ScmManifest = {
  provider: 'fake',
  scm: { draftPullRequests: true, pullRequestThreads: false },
};

describe('BaseScmAdapter pull-request-thread gap', () => {
  it('adds a thread when the provider supports threads', async () => {
    const adapter = new BaseScmAdapter(withDraft, transport);
    const thread = await adapter.addPullRequestThread('pr1', 'hi');
    expect(thread.id).toBeTruthy();
  });

  it('degrades and warns when threads are unsupported', async () => {
    const log = new RecordingLogger();
    const adapter = new BaseScmAdapter(
      noThreads,
      transport,
      { pullRequestThreads: { kind: 'degrade' } },
      log,
    );
    const thread = await adapter.addPullRequestThread('pr1', 'hi');
    expect(thread.id).toBeTruthy();
    expect(log.entries.some((e) => e.level === 'warn')).toBe(true);
  });

  it('errors on a thread under the strict default policy (never silent)', async () => {
    const adapter = new BaseScmAdapter(noThreads, transport);
    await expect(adapter.addPullRequestThread('pr1', 'hi')).rejects.toBeInstanceOf(
      CapabilityGapError,
    );
  });
});
