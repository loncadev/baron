import {
  BaronError,
  BaseScmAdapter,
  type GapPolicy,
  type Logger,
  type MergeOptions,
  type MergeResult,
  type MergeStrategy,
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
  GitPullRequestMergeStrategy,
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
  scm: {
    draftPullRequests: true,
    pullRequestThreads: true,
    // Azure Repos PRs have REVIEWERS, not assignees — a different role (who approves vs who owns
    // getting it merged). Rather than pretend, declare the gap and let the policy decide.
    pullRequestAssignees: false,
    // Auto-complete: merge once branch policies pass (autoCompleteSetBy + completionOptions).
    autoComplete: true,
  },
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

/** Baron's abstract strategies -> Azure's merge-strategy enum. */
const MERGE_STRATEGY: Record<MergeStrategy, GitPullRequestMergeStrategy> = {
  merge: GitPullRequestMergeStrategy.NoFastForward,
  squash: GitPullRequestMergeStrategy.Squash,
  rebase: GitPullRequestMergeStrategy.Rebase,
};

type GitApi = Awaited<ReturnType<InstanceType<typeof azdev.WebApi>['getGitApi']>>;

/**
 * Append Azure's native work-item mention (`AB#123`) so the PR is genuinely LINKED to the item —
 * Azure resolves the mention into a real work-item link on the PR. A comment carrying the PR URL
 * (which the recipe also posts) is not a link; this is.
 */
function withIssueLink(body: string | undefined, issueKey: string | undefined): string | undefined {
  if (issueKey === undefined || issueKey.length === 0) return body;
  const link = `AB#${issueKey.replace(/^AB#/i, '')}`;
  return body === undefined || body.length === 0 ? link : `${body}\n\n${link}`;
}

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

  const webApi = new azdev.WebApi(orgUrl, azdev.getPersonalAccessTokenHandler(token));

  let gitApi: Promise<GitApi> | undefined;
  const api = (): Promise<GitApi> => {
    gitApi ??= webApi.getGitApi();
    return gitApi;
  };

  // Auto-complete is attributed to an identity ("set by"), so it needs the token owner's id — not a
  // name. Read it from the connection once and cache it.
  let cachedIdentityId: Promise<string | undefined> | undefined;
  const currentIdentityId = (): Promise<string | undefined> => {
    cachedIdentityId ??= webApi
      .connect()
      .then((connection) => connection.authenticatedUser?.id)
      .catch(() => undefined);
    return cachedIdentityId;
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
        return { name, sha: existing.commit.commitId, created: false };
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
      return { name, sha: baseSha, created: true };
    },

    async createPullRequest(input: NativePullRequestInput): Promise<NativePullRequest> {
      const git = await api();
      const description = withIssueLink(input.body, input.linkedIssueKey);
      const toCreate: GitPullRequest = {
        sourceRefName: `refs/heads/${input.sourceBranch}`,
        targetRefName: `refs/heads/${input.targetBranch}`,
        title: input.title,
        isDraft: input.draft,
        ...(description !== undefined ? { description } : {}),
      };
      const pr = await git.createPullRequest(toCreate, repository, project);
      const id = String(pr.pullRequestId ?? '');

      // Auto-complete is a follow-up update: Azure needs the PR to exist, then records WHO enabled it
      // plus what to do on completion. Report the outcome rather than failing the created PR — an
      // org that forbids it (or a missing identity) is a provider condition, not a Baron error.
      let autoCompleteEnabled: boolean | undefined;
      if (input.autoComplete === true) {
        const identityId = await currentIdentityId();
        autoCompleteEnabled =
          identityId === undefined
            ? false
            : await git
                .updatePullRequest(
                  {
                    autoCompleteSetBy: { id: identityId },
                    completionOptions: { deleteSourceBranch: true, transitionWorkItems: false },
                  },
                  repository,
                  Number(id),
                  project,
                )
                .then(() => true)
                .catch(() => false);
      }

      return {
        autoCompleteEnabled,
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

    async markPullRequestReady(pullRequestId: string): Promise<NativePullRequest> {
      const git = await api();
      const pr = await git.updatePullRequest(
        { isDraft: false },
        repository,
        Number(pullRequestId),
        project,
      );
      const id = String(pr.pullRequestId ?? pullRequestId);
      const strip = (ref: string | undefined): string =>
        ref?.startsWith(REFS_HEADS) ? ref.slice(REFS_HEADS.length) : (ref ?? '');
      return {
        id,
        number: id,
        title: pr.title ?? '',
        url: prWebUrl(id),
        sourceBranch: strip(pr.sourceRefName),
        targetBranch: strip(pr.targetRefName),
        draft: pr.isDraft ?? false,
        state: toPrState(pr.status),
      };
    },

    async mergePullRequest(pullRequestId: string, options: MergeOptions): Promise<MergeResult> {
      const git = await api();
      // Azure completes a PR by PATCHing it to Completed, and it demands the source commit it is
      // completing — so read the PR first rather than guessing.
      const current = await git.getPullRequestById(Number(pullRequestId), project);
      const completed = await git.updatePullRequest(
        {
          status: AzurePrStatus.Completed,
          ...(current.lastMergeSourceCommit !== undefined
            ? { lastMergeSourceCommit: current.lastMergeSourceCommit }
            : {}),
          completionOptions: {
            ...(options.strategy !== undefined
              ? { mergeStrategy: MERGE_STRATEGY[options.strategy] }
              : {}),
            ...(options.deleteSourceBranch !== undefined
              ? { deleteSourceBranch: options.deleteSourceBranch }
              : {}),
          },
        },
        repository,
        Number(pullRequestId),
        project,
      );
      if (completed.status !== AzurePrStatus.Completed) {
        throw new BaronError(
          `Azure did not complete PR ${pullRequestId} (status ${String(completed.status)}); check branch policies and conflicts.`,
          'MERGE_FAILED',
        );
      }
      return { pullRequestId, sha: completed.lastMergeCommit?.commitId };
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
        // Azure PR checks are policy evaluations (a separate Policy API) this slice does not read.
        // 'unknown', not 'none': claiming "no checks" would tell a caller the merge is unblocked by
        // CI when Baron simply never looked — the same false green a missing permission produces.
        checks: {
          total: 0,
          succeeded: 0,
          failed: 0,
          pending: 0,
          rollup: 'unknown',
          unreadable: ['policy-evaluations'],
          // Not a permission the caller can grant: this adapter does not read the Policy API yet.
          // Say so, rather than let a caller hunt for a setting that would not help.
          remedy:
            'Azure PR checks are branch-policy evaluations, which this adapter does not read yet — ' +
            'no permission change will make them visible. Check the PR in Azure DevOps.',
        },
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
