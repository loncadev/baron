import { describe, expect, it } from 'vitest';
import { createGithubScmTransport, defineGithubScmAdapter } from './index.js';

const owner = process.env.GITHUB_OWNER;
const repo = process.env.GITHUB_REPO;
const token = process.env.GITHUB_TOKEN;
const base = process.env.BARON_SMOKE_BASE_BRANCH ?? 'main';
const live = Boolean(owner && repo && token);

/**
 * Gated live smoke for the GitHub scm port: skipped unless GITHUB_OWNER/REPO/TOKEN are present.
 * It CREATES a branch + draft PR + comment in the target repo, so point it at a throwaway repo.
 * Never commit credentials.
 */
describe.skipIf(!live)('github scm live smoke', () => {
  it('creates a branch, opens a draft PR, and adds a thread', async () => {
    const adapter = defineGithubScmAdapter(
      createGithubScmTransport({ owner: owner!, repo: repo!, token: token! }),
    );
    const name = `baron/smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`;

    const branch = await adapter.createBranch({ name, fromBranch: base });
    expect(branch.sha).toBeTruthy();

    const pr = await adapter.createPullRequest({
      title: 'baron scm smoke',
      sourceBranch: name,
      targetBranch: base,
      draft: true,
    });
    expect(pr.draft).toBe(true);

    const thread = await adapter.addPullRequestThread(pr.id, 'baron scm smoke thread');
    expect(thread.id).toBeTruthy();
  });
});
