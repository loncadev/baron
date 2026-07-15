import type {
  NativeBranch,
  NativePullRequest,
  NativePullRequestInput,
  NativeThread,
  PrState,
  PrStateFilter,
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
  const prs: NativePullRequest[] = [];
  const branches = new Map<string, NativeBranch>();

  return {
    async createBranch(name: string, fromBranch: string): Promise<NativeBranch> {
      // Idempotent (contract): a second create of the same name returns the existing branch, and
      // reports created:false so callers can tell a real creation from a resume no-op.
      const existing = branches.get(name);
      if (existing !== undefined) return { ...existing, created: false };
      const branch: NativeBranch = {
        name,
        sha: `sha-${fromBranch}->${name}`,
        url: `mem://branch/${name}`,
        created: true,
      };
      branches.set(name, branch);
      return branch;
    },

    async createPullRequest(input: NativePullRequestInput): Promise<NativePullRequest> {
      prSeq += 1;
      const pr: NativePullRequest = {
        id: `mem-pr-${prSeq}`,
        number: String(prSeq),
        title: input.title,
        url: `mem://pr/${prSeq}`,
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
        draft: input.draft,
        state: 'open',
      };
      prs.push(pr);
      return pr;
    },

    async findPullRequestByBranch(
      sourceBranch: string,
      stateFilter: PrStateFilter,
    ): Promise<NativePullRequest | undefined> {
      // Memory PRs are created open; a test drives merged/closed by setting `.state` on the record.
      const forBranch = [...prs].reverse().filter((pr) => pr.sourceBranch === sourceBranch);
      const state = (pr: NativePullRequest): PrState => pr.state ?? 'open';
      return stateFilter === 'all'
        ? forBranch[0]
        : forBranch.find((pr) => state(pr) === stateFilter);
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
