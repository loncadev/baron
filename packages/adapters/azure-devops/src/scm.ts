import {
  BaronError,
  BaseScmAdapter,
  type GapPolicy,
  type Logger,
  type NativeBranch,
  type NativePullRequest,
  type NativePullRequestInput,
  type NativeThread,
  type ScmManifest,
  type ScmTransport,
} from '@baron/core';
import * as azdev from 'azure-devops-node-api';
import {
  type GitPullRequest,
  GitRefUpdateStatus,
} from 'azure-devops-node-api/interfaces/GitInterfaces.js';
import { AZURE_DEVOPS_PROVIDER } from './provider.js';

export interface AzureDevOpsScmTransportOptions {
  readonly organization: string;
  readonly project: string;
  /** Repository id or name. */
  readonly repository: string;
  /** Personal access token. Read from env / secret-manager by the caller; never committed. */
  readonly token: string;
}

/** Azure Repos supports draft PRs and first-class PR comment threads. */
export const azureDevOpsScmManifest: ScmManifest = {
  provider: AZURE_DEVOPS_PROVIDER,
  scm: { draftPullRequests: true, pullRequestThreads: true },
};

const ZERO_OBJECT_ID = '0000000000000000000000000000000000000000';

type GitApi = Awaited<ReturnType<InstanceType<typeof azdev.WebApi>['getGitApi']>>;

/**
 * Live `scm` transport over the Azure DevOps REST API (azure-devops-node-api GitApi). Branches are
 * created with an atomic ref update from the base branch's tip; PRs use full `refs/heads/*` ref
 * names; a PR thread is a native comment thread. The GitApi client is built lazily and cached.
 */
export function createAzureDevOpsScmTransport(
  options: AzureDevOpsScmTransportOptions,
): ScmTransport {
  const { organization, project, repository, token } = options;
  const orgUrl = `https://dev.azure.com/${organization}`;

  let gitApi: Promise<GitApi> | undefined;
  const api = (): Promise<GitApi> => {
    gitApi ??= new azdev.WebApi(orgUrl, azdev.getPersonalAccessTokenHandler(token)).getGitApi();
    return gitApi;
  };

  const prWebUrl = (id: string): string =>
    `${orgUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}/pullrequest/${id}`;

  return {
    async createBranch(name: string, fromBranch: string): Promise<NativeBranch> {
      const git = await api();
      const base = await git.getBranch(repository, fromBranch, project);
      const baseSha = base.commit?.commitId;
      if (baseSha === undefined) {
        throw new BaronError(
          `Base branch '${fromBranch}' not found in repository '${repository}'.`,
          'BRANCH_NOT_FOUND',
        );
      }
      const [result] = await git.updateRefs(
        [{ name: `refs/heads/${name}`, oldObjectId: ZERO_OBJECT_ID, newObjectId: baseSha }],
        repository,
        project,
      );
      // Treat anything other than an explicit success as failure — an empty result array (undefined
      // result) or a missing `success` must not be reported as a created branch (invariant #5).
      if (result?.success !== true) {
        const status = result?.updateStatus;
        const statusName =
          status !== undefined ? (GitRefUpdateStatus[status] ?? String(status)) : undefined;
        const hint =
          status === GitRefUpdateStatus.StaleOldObjectId ? ' (the branch may already exist)' : '';
        const detail = result?.customMessage ?? statusName ?? 'ref update rejected';
        throw new BaronError(
          `Failed to create branch '${name}': ${detail}${hint}.`,
          'BRANCH_CREATE_FAILED',
        );
      }
      return { name, sha: baseSha };
    },

    async createPullRequest(input: NativePullRequestInput): Promise<NativePullRequest> {
      const git = await api();
      const toCreate: GitPullRequest = {
        sourceRefName: `refs/heads/${input.sourceBranch}`,
        targetRefName: `refs/heads/${input.targetBranch}`,
        title: input.title,
        isDraft: input.draft,
        ...(input.body !== undefined ? { description: input.body } : {}),
      };
      const pr = await git.createPullRequest(toCreate, repository, project);
      const id = String(pr.pullRequestId ?? '');
      return {
        id,
        number: id,
        title: pr.title ?? input.title,
        url: prWebUrl(id),
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
        draft: pr.isDraft ?? input.draft,
      };
    },

    async addPullRequestThread(pullRequestId: string, body: string): Promise<NativeThread> {
      const git = await api();
      const thread = await git.createThread(
        { comments: [{ content: body }] },
        repository,
        Number(pullRequestId),
        project,
      );
      return { id: String(thread.id ?? '') };
    },
  };
}

export function defineAzureDevOpsScmAdapter(
  transport: ScmTransport,
  gapPolicy?: GapPolicy,
  logger?: Logger,
): BaseScmAdapter {
  return new BaseScmAdapter(azureDevOpsScmManifest, transport, gapPolicy, logger);
}
