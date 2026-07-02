import type {
  NativeBranch,
  NativePullRequest,
  NativePullRequestInput,
  NativeThread,
  ScmTransport,
} from '@lonca/baron-core';

/**
 * In-memory stand-in for an `scm` transport. Deterministic and network-free so the scm conformance
 * suite (and the MCP/port logic) can be exercised without a live git provider; the live transports
 * are validated separately by gated smoke tests.
 */
export function createMemoryScmTransport(): ScmTransport {
  let prSeq = 0;
  let threadSeq = 0;

  return {
    async createBranch(name: string, fromBranch: string): Promise<NativeBranch> {
      return { name, sha: `sha-${fromBranch}->${name}`, url: `mem://branch/${name}` };
    },

    async createPullRequest(input: NativePullRequestInput): Promise<NativePullRequest> {
      prSeq += 1;
      return {
        id: `mem-pr-${prSeq}`,
        number: String(prSeq),
        title: input.title,
        url: `mem://pr/${prSeq}`,
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
        draft: input.draft,
      };
    },

    async addPullRequestThread(pullRequestId: string, _body: string): Promise<NativeThread> {
      threadSeq += 1;
      return {
        id: `mem-thread-${threadSeq}`,
        url: `mem://pr/${pullRequestId}/thread/${threadSeq}`,
      };
    },

    async defaultBranch(): Promise<string> {
      return 'main';
    },

    async getPullRequestStatus(pullRequestId: string) {
      return {
        id: pullRequestId,
        state: 'open' as const,
        reviewDecision: 'review_required' as const,
        mergeable: true,
        checks: { total: 1, succeeded: 1, failed: 0, pending: 0, rollup: 'succeeded' as const },
        url: `mem://pr/${pullRequestId}`,
      };
    },
  };
}
