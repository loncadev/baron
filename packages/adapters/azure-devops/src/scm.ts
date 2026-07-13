import {
  BaronError,
  BaseScmAdapter,
  type GapPolicy,
  type Logger,
  type NativeBranch,
  type NativePullRequest,
  type NativePullRequestInput,
  type NativeThread,
  type PrState,
  type PrStateFilter,
  type PullRequestStatus,
  type ReviewDecision,
  type ScmManifest,
  type ScmTransport,
} from '@lonca/baron-core';
import * as azdev from 'azure-devops-node-api';
import {
  PullRequestStatus as AzurePrStatus,
  type GitPullRequest,
  GitRefUpdateStatus,
  PullRequestAsyncStatus,
} from 'azure-devops-node-api/interfaces/GitInterfaces.js';
import { AZURE_DEVOPS_PROVIDER } from './provider.js';

export interface AzureDevOpsScmTransportOptions {
  readonly organization: string;
  readonly project: string;
  /** Repository id or name. */
  readonly repository: string;
  /** Personal access token. Read from env / secret-manager by the caller; never committed. */
  readonly token: string;
  /**
   * Integration branch to fork from and target PRs at when a recipe omits the branch. Many teams
   * merge into `dev` while the repo default is `release`/`main`, so this is configurable; defaults
   * to the repository's default branch when unset.
   */
  readonly baseBranch?: string | undefined;
}

/** Azure Repos supports draft PRs and first-class PR comment threads. */
export const azureDevOpsScmManifest: ScmManifest = {
  provider: AZURE_DEVOPS_PROVIDER,
  scm: { draftPullRequests: true, pullRequestThreads: true },
};

const ZERO_OBJECT_ID = '0000000000000000000000000000000000000000';

/** Azure PR status -> normalized PrState (shared by findPullRequestByBranch + getPullRequestStatus). */
function toPrState(status: AzurePrStatus | undefined): PrState {
  if (status === AzurePrStatus.Completed) return 'merged';
  if (status === AzurePrStatus.Abandoned) return 'closed';
  if (status === AzurePrStatus.Active) return 'open';
  return 'unknown';
}

/** Normalized state filter -> the Azure PR status to search by. `all` searches every status. */
function toAzureStatusFilter(filter: PrStateFilter): AzurePrStatus {
  switch (filter) {
    case 'merged':
      return AzurePrStatus.Completed;
    case 'closed':
      return AzurePrStatus.Abandoned;
    case 'all':
      return AzurePrStatus.All;
    default:
      return AzurePrStatus.Active;
  }
}

type GitApi = Awaited<ReturnType<InstanceType<typeof azdev.WebApi>['getGitApi']>>;

/**
 * Live `scm` transport over the Azure DevOps REST API (azure-devops-node-api GitApi). Branches are
 * created with an atomic ref update from the base branch's tip; PRs use full `refs/heads/*` ref
 * names; a PR thread is a native comment thread. The GitApi client is built lazily and cached.
 */
export function createAzureDevOpsScmTransport(
  options: AzureDevOpsScmTransportOptions,
): ScmTransport {
  const { organization, project, repository, token, baseBranch } = options;
  const orgUrl = `https://dev.azure.com/${organization}`;

  let gitApi: Promise<GitApi> | undefined;
  const api = (): Promise<GitApi> => {
    gitApi ??= new azdev.WebApi(orgUrl, azdev.getPersonalAccessTokenHandler(token)).getGitApi();
    return gitApi;
  };

  const REFS_HEADS = 'refs/heads/';
  let cachedDefaultBranch: Promise<string> | undefined;

  const prWebUrl = (id: string): string =>
    `${orgUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}/pullrequest/${id}`;

  return {
    async createBranch(name: string, fromBranch: string): Promise<NativeBranch> {
      const git = await api();
      // Idempotent: if the branch already exists (a resumed task-start), return it instead of
      // failing, so the caller flows on to transition/assign rather than aborting here. getBranch
      // throws for a missing branch, so a rejection means "not found" → fall through to create.
      const existing = await git.getBranch(repository, name, project).catch(() => undefined);
      if (existing?.commit?.commitId !== undefined) {
        return { name, sha: existing.commit.commitId };
      }
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

    async findPullRequestByBranch(
      sourceBranch: string,
      stateFilter: PrStateFilter,
    ): Promise<NativePullRequest | undefined> {
      const git = await api();
      // Newest first (getPullRequests returns creation-desc); take the most recent match.
      const matches = await git.getPullRequests(
        repository,
        {
          sourceRefName: `${REFS_HEADS}${sourceBranch}`,
          status: toAzureStatusFilter(stateFilter),
        },
        project,
        undefined,
        undefined,
        1,
      );
      const pr = matches[0];
      if (pr?.pullRequestId === undefined) return undefined;
      const id = String(pr.pullRequestId);
      const stripRef = (ref: string | undefined): string =>
        ref?.startsWith(REFS_HEADS) ? ref.slice(REFS_HEADS.length) : (ref ?? '');
      return {
        id,
        number: id,
        title: pr.title ?? '',
        url: prWebUrl(id),
        sourceBranch: stripRef(pr.sourceRefName),
        targetBranch: stripRef(pr.targetRefName),
        draft: pr.isDraft ?? false,
        state: toPrState(pr.status),
      };
    },

    async getPullRequestStatus(pullRequestId: string): Promise<PullRequestStatus> {
      const git = await api();
      const pr = await git.getPullRequestById(Number(pullRequestId), project);
      const state = toPrState(pr.status);
      // Azure reviewer votes: 10/5 approve, 0 none, -5 waiting-for-author, -10 rejected.
      const votes = (pr.reviewers ?? []).map((r) => r.vote ?? 0);
      const hasReject = votes.some((v) => v <= -10);
      const hasApprove = votes.some((v) => v >= 5);
      const hasWaiting = votes.some((v) => v === -5);
      const reviewDecision: ReviewDecision = hasReject
        ? 'changes_requested'
        : hasApprove && !hasWaiting
          ? 'approved'
          : hasApprove || hasWaiting
            ? 'pending'
            : 'review_required';
      const mergeable =
        pr.mergeStatus === PullRequestAsyncStatus.Succeeded
          ? true
          : pr.mergeStatus === PullRequestAsyncStatus.Conflicts
            ? false
            : undefined;
      const id = String(pr.pullRequestId ?? pullRequestId);
      return {
        id,
        state,
        reviewDecision,
        ...(mergeable !== undefined ? { mergeable } : {}),
        // Azure PR checks are policy evaluations (a separate Policy API) — not surfaced in this slice.
        checks: { total: 0, succeeded: 0, failed: 0, pending: 0, rollup: 'none' },
        url: prWebUrl(id),
      };
    },

    defaultBranch(): Promise<string> {
      // A configured integration branch (e.g. 'dev') wins over the repo default (often 'release'),
      // so branch.create forks from it and pr.create targets it — matching the team's real flow.
      if (baseBranch !== undefined && baseBranch.length > 0) return Promise.resolve(baseBranch);
      cachedDefaultBranch ??= (async () => {
        const git = await api();
        const repo = await git.getRepository(repository, project);
        const ref = repo.defaultBranch; // e.g. 'refs/heads/release'
        if (ref === undefined || ref.length === 0) {
          throw new BaronError(
            `Repository '${repository}' has no default branch; pass an explicit branch.`,
            'DEFAULT_BRANCH_UNKNOWN',
          );
        }
        return ref.startsWith(REFS_HEADS) ? ref.slice(REFS_HEADS.length) : ref;
      })();
      return cachedDefaultBranch;
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
