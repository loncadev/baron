import {
  ASSIGNEE_ME,
  BaronError,
  BaseScmAdapter,
  type CheckRollup,
  type CheckSummary,
  type GapPolicy,
  type Logger,
  type MergeOptions,
  type MergeResult,
  type MergeStrategy,
  type NativeBranch,
  type NativePullRequest,
  type NativePullRequestInput,
  type NativeThread,
  type PrIssueRelation,
  type PrState,
  type PrStateFilter,
  type PullRequestStatus,
  type ReviewDecision,
  type ScmManifest,
  type ScmTransport,
} from '@lonca/baron-core';
import { createGithubOctokit } from './octokit.js';
import { GITHUB_PROVIDER } from './provider.js';
import type { GithubTransportOptions } from './transport.js';

/** GitHub supports draft PRs and PR discussion (PR-level issue comments). */
export const githubScmManifest: ScmManifest = {
  provider: GITHUB_PROVIDER,
  scm: {
    draftPullRequests: true,
    pullRequestThreads: true,
    // A GitHub PR is an issue, so it carries assignees.
    pullRequestAssignees: true,
    // "Auto-merge": enabling it is GraphQL-only (REST has no endpoint) and the repo must allow it.
    autoComplete: true,
  },
};

/**
 * Live `scm` transport over the GitHub REST API (octokit). Branches are created via the git refs
 * API (read the base ref's sha, create a new ref). A PR "thread" is a PR-level discussion comment —
 * GitHub models PRs as issues, so it is an issue comment on the PR number (a positioned review
 * thread would need a diff location, which the abstract primitive does not carry).
 */
/**
 * Append GitHub's native linking keyword so the PR is genuinely LINKED to the work item — it appears
 * in the issue's Development panel. A comment carrying the PR URL (which the recipe also posts) is
 * not a link; this is.
 *
 * `Closes` also closes the item on merge, and rendering it unconditionally made every PR claim to
 * finish the item it mentioned — a spike or the first of several PRs included. `Refs` references
 * without closing.
 */
const GITHUB_LINK_KEYWORD: Record<PrIssueRelation, string> = { closes: 'Closes', relates: 'Refs' };

function withIssueLink(
  body: string | undefined,
  issueKey: string | undefined,
  relation: PrIssueRelation = 'closes',
): string | undefined {
  if (issueKey === undefined || issueKey.length === 0) return body;
  const link = `${GITHUB_LINK_KEYWORD[relation]} #${issueKey.replace(/^#/, '')}`;
  return body === undefined || body.length === 0 ? link : `${body}\n\n${link}`;
}

/** Baron's abstract strategies -> GitHub's merge_method. */
const MERGE_METHOD: Record<MergeStrategy, 'merge' | 'squash' | 'rebase'> = {
  merge: 'merge',
  squash: 'squash',
  rebase: 'rebase',
};

export function createGithubScmTransport(options: GithubTransportOptions): ScmTransport {
  const { owner, repo, token, baseBranch } = options;
  const octokit = createGithubOctokit(token, 'scm');

  // '@me' has no REST equivalent; resolve the token's login once and cache it (same contract as the
  // issues transport, so a PR and its work item end up assigned to the same person).
  let myLogin: Promise<string> | undefined;
  const resolveAssignee = (assignee: string): Promise<string> => {
    if (assignee !== ASSIGNEE_ME) return Promise.resolve(assignee);
    myLogin ??= octokit.rest.users.getAuthenticated().then(({ data }) => data.login);
    return myLogin;
  };

  /**
   * A PR head's CI state, read through whichever door this credential can actually open.
   *
   * Check runs are the complete picture, but a fine-grained PAT can NEVER see them: "Checks" is not
   * among the repository permissions a fine-grained token can be granted at all — it exists only for
   * GitHub Apps. So the common case for a human's token is a 403 here, and failing the whole status
   * call on it would also throw away the review decision and mergeability the token CAN read.
   *
   * The fallbacks are the two permissions a fine-grained PAT can hold: `Actions` sees the workflow
   * runs GitHub Actions produces, and `Commit statuses` sees what third-party CI posts. They cover
   * different producers, so counting both is not double-counting.
   */
  async function checkSummary(sha: string): Promise<CheckSummary> {
    let succeeded = 0;
    let failed = 0;
    let pending = 0;
    const unreadable: string[] = [];
    /**
     * Only a source that would surface GitHub Actions can justify concluding "there is no CI here".
     * The combined-status API is NOT one: Actions never writes legacy commit statuses, so reading it
     * successfully and finding it empty proves nothing about whether a workflow is red. Letting that
     * read alone count as "I saw the picture" turned a blind spot into `none` — a green light.
     */
    let sawActionsCapableSource = false;

    // A 403 is "this credential may not look", which is a different fact from "there is nothing to
    // see" — swallow only that, so a real outage still surfaces as an error.
    const ifPermitted = async (source: string, read: () => Promise<void>): Promise<boolean> => {
      try {
        await read();
        return true;
      } catch (error) {
        if ((error as { status?: number }).status !== 403) throw error;
        unreadable.push(source);
        return false;
      }
    };

    sawActionsCapableSource = await ifPermitted('check-runs', async () => {
      const { data } = await octokit.rest.checks.listForRef({
        owner,
        repo,
        ref: sha,
        per_page: 100,
      });
      for (const run of data.check_runs) {
        if (run.status !== 'completed') pending += 1;
        else if (
          run.conclusion === 'success' ||
          run.conclusion === 'neutral' ||
          run.conclusion === 'skipped'
        )
          succeeded += 1;
        else failed += 1;
      }
    });

    if (!sawActionsCapableSource) {
      sawActionsCapableSource = await ifPermitted('actions-runs', async () => {
        const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
          owner,
          repo,
          head_sha: sha,
          per_page: 100,
        });
        for (const run of data.workflow_runs) {
          if (run.status !== 'completed') pending += 1;
          else if (
            run.conclusion === 'success' ||
            run.conclusion === 'neutral' ||
            run.conclusion === 'skipped'
          )
            succeeded += 1;
          else failed += 1;
        }
      });
      // Counted, but deliberately does NOT set sawActionsCapableSource: third-party CI that posts
      // legacy statuses is real signal, yet its absence says nothing about a workflow.
      await ifPermitted('commit-statuses', async () => {
        const { data } = await octokit.rest.repos.getCombinedStatusForRef({
          owner,
          repo,
          ref: sha,
        });
        for (const status of data.statuses) {
          if (status.state === 'pending') pending += 1;
          else if (status.state === 'success') succeeded += 1;
          else failed += 1;
        }
      });
    }

    const total = succeeded + failed + pending;
    // A failure or a run still going is DEFINITE — it stays definite even when the view is partial.
    // Only the reassuring conclusions ("all green", "nothing to run") need to have seen everything,
    // because those are the ones a caller merges on.
    const rollup: CheckRollup =
      failed > 0
        ? 'failed'
        : pending > 0
          ? 'pending'
          : !sawActionsCapableSource
            ? 'unknown'
            : total === 0
              ? 'none'
              : 'succeeded';
    return {
      total,
      succeeded,
      failed,
      pending,
      rollup,
      ...(unreadable.length > 0
        ? {
            unreadable,
            // Named here because it is GitHub's answer, not a recipe's guess. Checks itself cannot
            // be granted to a fine-grained token at all — that permission exists only for GitHub
            // Apps — so these two are the only way in.
            remedy:
              'Add Actions (Read) and Commit statuses (Read) to the token. A fine-grained token ' +
              'cannot be granted Checks at all; those two are the only way to see workflow results.',
          }
        : {}),
    };
  }

  return {
    async createBranch(name: string, fromBranch: string): Promise<NativeBranch> {
      // getRef takes the ref WITHOUT a leading 'refs/'; createRef requires it WITH 'refs/'.
      // Idempotent: a resumed task-start finds the branch already there — return it, don't fail
      // (getRef 404s for a missing branch, so a rejection means "not found" → create it).
      const existing = await octokit.rest.git
        .getRef({ owner, repo, ref: `heads/${name}` })
        .then((r) => r.data)
        .catch(() => undefined);
      if (existing !== undefined) {
        return { name, sha: existing.object.sha, url: existing.url, created: false };
      }
      const base = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${fromBranch}` });
      const created = await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${name}`,
        sha: base.data.object.sha,
      });
      return { name, sha: created.data.object.sha, url: created.data.url, created: true };
    },

    async createPullRequest(input: NativePullRequestInput): Promise<NativePullRequest> {
      const body = withIssueLink(input.body, input.linkedIssueKey, input.linkedIssueRelation);
      const { data } = await octokit.rest.pulls.create({
        owner,
        repo,
        title: input.title,
        ...(body !== undefined ? { body } : {}),
        head: input.sourceBranch,
        base: input.targetBranch,
        draft: input.draft,
      });

      // A PR is an issue here, so assignees go through the issues endpoint. '@me' resolves to the
      // token owner — the person finishing the task should own the PR without a manual UI step.
      if (input.assignees !== undefined && input.assignees.length > 0) {
        const logins = await Promise.all(input.assignees.map((a) => resolveAssignee(a)));
        await octokit.rest.issues.addAssignees({
          owner,
          repo,
          issue_number: data.number,
          assignees: logins,
        });
      }

      // Auto-merge is GraphQL-only (no REST endpoint) and requires the repo to allow it. A repo with
      // it disabled rejects the mutation — a provider setting, not a Baron failure — so report the
      // outcome instead of either failing the created PR or silently pretending it worked.
      let autoCompleteEnabled: boolean | undefined;
      if (input.autoComplete === true) {
        autoCompleteEnabled = await octokit
          .graphql(
            'mutation($pr: ID!) { enablePullRequestAutoMerge(input: {pullRequestId: $pr}) { clientMutationId } }',
            { pr: data.node_id },
          )
          .then(() => true)
          .catch(() => false);
      }

      return {
        autoCompleteEnabled,
        id: String(data.number),
        number: String(data.number),
        title: data.title,
        url: data.html_url,
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
        draft: data.draft ?? input.draft,
      };
    },

    async addPullRequestThread(pullRequestId: string, body: string): Promise<NativeThread> {
      const { data } = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: Number(pullRequestId),
        body,
      });
      return { id: String(data.id), url: data.html_url };
    },

    async findPullRequestByBranch(
      sourceBranch: string,
      stateFilter: PrStateFilter,
    ): Promise<NativePullRequest | undefined> {
      // GitHub has no "merged" list state — merged is a subset of `closed` (merged_at set). So for
      // merged/closed we list closed and filter client-side; open/all map directly.
      const listState = stateFilter === 'open' ? 'open' : stateFilter === 'all' ? 'all' : 'closed';
      // `head` must be owner-qualified or it matches nothing (GitHub treats it as a full ref filter).
      const { data } = await octokit.rest.pulls.list({
        owner,
        repo,
        state: listState,
        head: `${owner}:${sourceBranch}`,
        sort: 'created',
        direction: 'desc',
        per_page: stateFilter === 'open' || stateFilter === 'all' ? 1 : 20,
      });
      type PrItem = (typeof data)[number];
      const isMerged = (pr: PrItem): boolean => pr.merged_at != null;
      const prState = (pr: PrItem): PrState =>
        isMerged(pr) ? 'merged' : pr.state === 'closed' ? 'closed' : 'open';
      const match =
        stateFilter === 'merged'
          ? data.find(isMerged)
          : stateFilter === 'closed'
            ? data.find((pr) => pr.state === 'closed' && !isMerged(pr))
            : data[0];
      if (match === undefined) return undefined;
      return {
        id: String(match.number),
        number: String(match.number),
        title: match.title,
        url: match.html_url,
        sourceBranch,
        targetBranch: match.base.ref,
        draft: match.draft ?? false,
        state: prState(match),
      };
    },

    async defaultBranch(): Promise<string> {
      // A configured integration branch wins over the repo default (branch from + PR to it).
      if (baseBranch !== undefined && baseBranch.length > 0) return baseBranch;
      const { data } = await octokit.rest.repos.get({ owner, repo });
      return data.default_branch;
    },

    async markPullRequestReady(pullRequestId: string): Promise<NativePullRequest> {
      // Un-drafting is GraphQL-only on GitHub (no REST route), and the mutation keys on the node id.
      const { data } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: Number(pullRequestId),
      });
      await octokit.graphql(
        'mutation($pr: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $pr}) { clientMutationId } }',
        { pr: data.node_id },
      );
      return {
        id: String(data.number),
        number: String(data.number),
        title: data.title,
        url: data.html_url,
        sourceBranch: data.head.ref,
        targetBranch: data.base.ref,
        draft: false,
        state: 'open',
      };
    },

    async mergePullRequest(pullRequestId: string, options: MergeOptions): Promise<MergeResult> {
      const { data } = await octokit.rest.pulls.merge({
        owner,
        repo,
        pull_number: Number(pullRequestId),
        ...(options.strategy !== undefined ? { merge_method: MERGE_METHOD[options.strategy] } : {}),
      });
      // GitHub answers 405 when it refuses (conflict / unmet protection), which octokit throws —
      // so reaching here means it really landed. Guard the flag anyway rather than assume.
      if (data.merged !== true) {
        throw new BaronError(
          `GitHub did not merge PR #${pullRequestId}: ${data.message}`,
          'MERGE_FAILED',
        );
      }
      if (options.deleteSourceBranch === true) {
        const { data: pr } = await octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: Number(pullRequestId),
        });
        await octokit.rest.git
          .deleteRef({ owner, repo, ref: `heads/${pr.head.ref}` })
          .catch(() => undefined); // already gone / protected — the merge itself stands
      }
      return { pullRequestId, sha: data.sha };
    },

    async getPullRequestStatus(pullRequestId: string): Promise<PullRequestStatus> {
      const prNum = Number(pullRequestId);
      const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNum });
      const state = pr.merged
        ? 'merged'
        : pr.state === 'closed'
          ? 'closed'
          : pr.state === 'open'
            ? 'open'
            : 'unknown';

      // Latest decisive review per author → an aggregate decision.
      const { data: reviews } = await octokit.rest.pulls.listReviews({
        owner,
        repo,
        pull_number: prNum,
        per_page: 100,
      });
      const latest = new Map<string, string>();
      let hadComment = false;
      for (const r of reviews) {
        const login = r.user?.login;
        if (login === undefined) continue;
        if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED') latest.set(login, r.state);
        // A dismissed review no longer counts — drop the author's prior decisive review.
        else if (r.state === 'DISMISSED') latest.delete(login);
        else if (r.state === 'COMMENTED') hadComment = true;
      }
      const states = [...latest.values()];
      const reviewDecision: ReviewDecision = states.includes('CHANGES_REQUESTED')
        ? 'changes_requested'
        : states.includes('APPROVED')
          ? 'approved'
          : // engaged (commented) but undecided → pending; no engagement at all → review_required.
            hadComment
            ? 'pending'
            : 'review_required';

      const checks = await checkSummary(pr.head.sha);

      return {
        id: String(pr.number),
        state,
        reviewDecision,
        ...(pr.mergeable != null ? { mergeable: pr.mergeable } : {}),
        checks,
        url: pr.html_url,
      };
    },
  };
}

export function defineGithubScmAdapter(
  transport: ScmTransport,
  gapPolicy?: GapPolicy,
  logger?: Logger,
): BaseScmAdapter {
  return new BaseScmAdapter(githubScmManifest, transport, gapPolicy, logger);
}
