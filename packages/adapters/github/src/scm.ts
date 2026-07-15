import {
  BaseScmAdapter,
  type CheckRollup,
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
import { Octokit } from 'octokit';
import { GITHUB_PROVIDER } from './provider.js';
import type { GithubTransportOptions } from './transport.js';

/** GitHub supports draft PRs and PR discussion (PR-level issue comments). */
export const githubScmManifest: ScmManifest = {
  provider: GITHUB_PROVIDER,
  scm: { draftPullRequests: true, pullRequestThreads: true },
};

/**
 * Live `scm` transport over the GitHub REST API (octokit). Branches are created via the git refs
 * API (read the base ref's sha, create a new ref). A PR "thread" is a PR-level discussion comment —
 * GitHub models PRs as issues, so it is an issue comment on the PR number (a positioned review
 * thread would need a diff location, which the abstract primitive does not carry).
 */
export function createGithubScmTransport(options: GithubTransportOptions): ScmTransport {
  const { owner, repo, token, baseBranch } = options;
  const octokit = new Octokit({ auth: token });

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
      const { data } = await octokit.rest.pulls.create({
        owner,
        repo,
        title: input.title,
        ...(input.body !== undefined ? { body: input.body } : {}),
        head: input.sourceBranch,
        base: input.targetBranch,
        draft: input.draft,
      });
      return {
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

      // Check runs on the PR head → a rollup.
      const { data: checks } = await octokit.rest.checks.listForRef({
        owner,
        repo,
        ref: pr.head.sha,
        per_page: 100,
      });
      let succeeded = 0;
      let failed = 0;
      let pending = 0;
      for (const c of checks.check_runs) {
        if (c.status !== 'completed') pending += 1;
        else if (
          c.conclusion === 'success' ||
          c.conclusion === 'neutral' ||
          c.conclusion === 'skipped'
        )
          succeeded += 1;
        else failed += 1;
      }
      const total = checks.check_runs.length;
      const rollup: CheckRollup =
        total === 0 ? 'none' : failed > 0 ? 'failed' : pending > 0 ? 'pending' : 'succeeded';

      return {
        id: String(pr.number),
        state,
        reviewDecision,
        ...(pr.mergeable != null ? { mergeable: pr.mergeable } : {}),
        checks: { total, succeeded, failed, pending, rollup },
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
