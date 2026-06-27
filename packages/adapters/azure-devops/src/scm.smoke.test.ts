import { describe, expect, it } from 'vitest';
import { createAzureDevOpsScmTransport, defineAzureDevOpsScmAdapter } from './index.js';

const organization = process.env.AZURE_DEVOPS_ORG;
const project = process.env.AZURE_DEVOPS_PROJECT;
const repository = process.env.AZURE_DEVOPS_REPO;
const token = process.env.AZURE_DEVOPS_TOKEN;
const base = process.env.BARON_SMOKE_BASE_BRANCH ?? 'main';
const live = Boolean(organization && project && repository && token);

/**
 * Gated live smoke for the Azure Repos scm port: skipped unless AZURE_DEVOPS_ORG/PROJECT/REPO/TOKEN
 * are present. It CREATES a branch + draft PR + thread, so point it at a throwaway repo. Never
 * commit credentials.
 */
describe.skipIf(!live)('azure-devops scm live smoke', () => {
  it('creates a branch, opens a draft PR, and adds a thread', async () => {
    const adapter = defineAzureDevOpsScmAdapter(
      createAzureDevOpsScmTransport({
        organization: organization!,
        project: project!,
        repository: repository!,
        token: token!,
      }),
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
    expect(pr.id).toBeTruthy();

    const thread = await adapter.addPullRequestThread(pr.id, 'baron scm smoke thread');
    expect(thread.id).toBeTruthy();
  });
});
