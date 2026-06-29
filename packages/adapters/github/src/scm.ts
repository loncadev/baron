import {
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
  const { owner, repo, token } = options;
  const octokit = new Octokit({ auth: token });

  return {
    async createBranch(name: string, fromBranch: string): Promise<NativeBranch> {
      // getRef takes the ref WITHOUT a leading 'refs/'; createRef requires it WITH 'refs/'.
      const base = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${fromBranch}` });
      const created = await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${name}`,
        sha: base.data.object.sha,
      });
      return { name, sha: created.data.object.sha, url: created.data.url };
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

    async defaultBranch(): Promise<string> {
      const { data } = await octokit.rest.repos.get({ owner, repo });
      return data.default_branch;
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
