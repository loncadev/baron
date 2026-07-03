import type { GapPolicy, RecordingLogger, ScmPort } from '@lonca/baron-core';
import { describe, expect, it } from 'vitest';

export interface ScmConformanceTarget {
  readonly label: string;
  /** Build a fresh scm adapter (in-memory transport) with the given gap policy, plus its logger. */
  build(gapPolicy?: GapPolicy): { adapter: ScmPort; logger: RecordingLogger };
}

/**
 * The contract every `scm` adapter must satisfy. Source control is uniform enough across providers
 * that this asserts the same shape for all of them; the manifest + gap pattern still governs
 * divergent capabilities (e.g. draft PRs) — that branch is unit-tested in core where a provider
 * without the capability can be simulated.
 */
export function runScmConformance(target: ScmConformanceTarget): void {
  describe(`scm conformance: ${target.label}`, () => {
    it('declares the scm capabilities', () => {
      const { adapter } = target.build();
      expect(typeof adapter.manifest.scm.draftPullRequests).toBe('boolean');
      expect(typeof adapter.manifest.scm.pullRequestThreads).toBe('boolean');
    });

    it('createBranch returns a normalized branch', async () => {
      const { adapter } = target.build();
      const branch = await adapter.createBranch({ name: 'feature/x', fromBranch: 'main' });
      expect(branch.name).toBe('feature/x');
      expect(branch.sha).toBeTruthy();
    });

    it('createPullRequest returns a normalized PR and honors draft when supported', async () => {
      const { adapter } = target.build();
      const pr = await adapter.createPullRequest({
        title: 'Wire it',
        sourceBranch: 'feature/x',
        targetBranch: 'main',
        draft: true,
      });
      expect(pr.id).toBeTruthy();
      expect(pr.title).toBe('Wire it');
      expect(pr.sourceBranch).toBe('feature/x');
      expect(pr.targetBranch).toBe('main');
      if (adapter.manifest.scm.draftPullRequests) {
        expect(pr.draft).toBe(true);
      }
    });

    it('defaults the base branch to the repo default when fromBranch/targetBranch are omitted', async () => {
      const { adapter } = target.build();
      // Omitting the base must not throw — the port resolves it from the provider's default branch,
      // so recipes never hardcode 'main'.
      const branch = await adapter.createBranch({ name: 'feature/defaulted' });
      expect(branch.name).toBe('feature/defaulted');
      expect(branch.sha).toBeTruthy();

      const pr = await adapter.createPullRequest({
        title: 'PR',
        sourceBranch: 'feature/defaulted',
      });
      expect(pr.targetBranch).toBeTruthy();
    });

    it('reports a normalized pull-request status (state + review decision + checks rollup)', async () => {
      const { adapter } = target.build();
      const pr = await adapter.createPullRequest({ title: 'PR', sourceBranch: 'feature/x' });
      const status = await adapter.prStatus(pr.id);
      expect(['open', 'merged', 'closed', 'unknown']).toContain(status.state);
      expect(['approved', 'changes_requested', 'review_required', 'pending', 'unknown']).toContain(
        status.reviewDecision,
      );
      expect(['succeeded', 'failed', 'pending', 'none']).toContain(status.checks.rollup);
    });

    it('prForBranch finds the open PR (default filter) with its state, undefined otherwise', async () => {
      const { adapter } = target.build();
      // The idempotency primitive behind "finish" flows: nothing yet -> undefined.
      expect(await adapter.prForBranch('feature/nothing-here')).toBeUndefined();
      const created = await adapter.createPullRequest({
        title: 'PR',
        sourceBranch: 'feature/find-me',
        targetBranch: 'main',
      });
      const found = await adapter.prForBranch('feature/find-me');
      expect(found?.id).toBe(created.id);
      expect(found?.sourceBranch).toBe('feature/find-me');
      // A just-opened PR is open — the state is populated, not left blank.
      expect(found?.state).toBe('open');
    });

    it('prForBranch filters by lifecycle state (a fresh PR is open, not merged)', async () => {
      const { adapter } = target.build();
      await adapter.createPullRequest({ title: 'PR', sourceBranch: 'feature/fresh' });
      // The drift probe: a brand-new PR has not merged, so the merged filter finds nothing.
      expect(await adapter.prForBranch('feature/fresh', 'merged')).toBeUndefined();
      // The open filter still finds it, and `all` returns the most recent regardless of state.
      expect((await adapter.prForBranch('feature/fresh', 'open'))?.state).toBe('open');
      expect((await adapter.prForBranch('feature/fresh', 'all'))?.sourceBranch).toBe(
        'feature/fresh',
      );
    });

    it('addPullRequestThread returns a thread reference', async () => {
      const { adapter } = target.build();
      const pr = await adapter.createPullRequest({
        title: 'PR',
        sourceBranch: 'feature/x',
        targetBranch: 'main',
      });
      const thread = await adapter.addPullRequestThread(pr.id, 'looks good');
      expect(thread.id).toBeTruthy();
    });
  });
}
