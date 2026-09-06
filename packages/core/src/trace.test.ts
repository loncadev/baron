import { describe, expect, it } from 'vitest';
import type { CiPort, RunQuery } from './ci.js';
import type { DeployPort, DeploymentQuery } from './deploy.js';
import type { Issue } from './issue.js';
import type { IssuesPort } from './ports.js';
import type { PrStateFilter, PullRequest, PullRequestStatus, ScmPort } from './scm.js';
import { TRACE_DEPLOYMENT_SCAN, TRACE_RUN_LIMIT, traceIssue } from './trace.js';

// Stubs rather than adapters: core cannot depend on an adapter package without a cycle, and trace
// only ever calls get, prForBranch, prStatus, runs and deployments — the contract is those five.

function issuesPort(issue: Partial<Issue>): IssuesPort {
  const full: Issue = {
    id: '7',
    key: '#7',
    title: 'Trace me',
    nativeType: 'issue',
    typeRole: 'task',
    blocked: false,
    nativeState: 'open',
    labels: [],
    branchName: 'task/7-trace-me',
    provider: 'mem',
    ...issue,
  };
  return { get: async () => full } as unknown as IssuesPort;
}

function scmPort(prs: PullRequest[]): ScmPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    manifest: { provider: 'mem' } as ScmPort['manifest'],
    async prForBranch(branch: string, state?: PrStateFilter) {
      calls.push(`prForBranch ${branch} ${state}`);
      return prs.find((p) => p.sourceBranch === branch);
    },
    async prStatus(id: string) {
      calls.push(`prStatus ${id}`);
      return {
        id,
        state: 'open',
        reviewDecision: 'none',
        checks: { total: 0, passed: 0, failed: 0, pending: 0 },
      } as unknown as PullRequestStatus;
    },
  } as unknown as ScmPort & { calls: string[] };
}

function ciPort(runsByBranch: Record<string, string[]>): CiPort & { queries: unknown[] } {
  const queries: unknown[] = [];
  return {
    queries,
    manifest: { provider: 'mem' } as CiPort['manifest'],
    async runs(query?: RunQuery) {
      queries.push(query);
      return (runsByBranch[query?.branch ?? ''] ?? []).map((id) => ({
        id,
        pipelineId: 'p',
        status: 'succeeded' as const,
        nativeStatus: 'ok',
        branch: query?.branch,
      }));
    },
  } as unknown as CiPort & { queries: unknown[] };
}

function deployPort(refs: string[]): DeployPort & { queries: unknown[] } {
  const queries: unknown[] = [];
  return {
    queries,
    manifest: { provider: 'mem' } as DeployPort['manifest'],
    async deployments(query?: DeploymentQuery) {
      queries.push(query);
      return refs.map((ref, i) => ({
        id: `d${i}`,
        environment: 'prod',
        status: 'succeeded' as const,
        nativeStatus: 'ok',
        ref,
      }));
    },
  } as unknown as DeployPort & { queries: unknown[] };
}

const BRANCH = 'task/7-trace-me';

describe('traceIssue', () => {
  it('reports the branch and names every port it could not consult', async () => {
    const trace = await traceIssue({ issues: issuesPort({}) }, '7');
    expect(trace.issue.key).toBe('#7');
    expect(trace.branch).toBe(BRANCH);
    expect(trace.pullRequest).toBeNull();
    expect(trace.checks).toBeNull();
    expect(trace.runs).toBeNull();
    expect(trace.deployment).toBeNull();
    expect(trace.missing).toEqual({
      pullRequest: 'The scm port is not bound.',
      checks: 'The scm port is not bound.',
      runs: 'The ci port is not bound.',
      deployment: 'The deploy port is not bound.',
    });
  });

  it('says a hop the item has not reached, by name, rather than leaving the part out', async () => {
    const issues = issuesPort({});
    const empty = scmPort([]);
    const before = await traceIssue({ issues, scm: empty }, '7');
    expect(before.pullRequest).toBeNull();
    expect(before.missing.pullRequest).toContain(BRANCH);
    expect(before.missing.checks).toBeDefined();
    // Any state, so a merged PR on a finished item is still found.
    expect(empty.calls).toEqual([`prForBranch ${BRANCH} all`]);

    const pr: PullRequest = {
      id: 'pr-1',
      title: 'Trace me',
      sourceBranch: BRANCH,
      targetBranch: 'main',
      draft: true,
    };
    const scm = scmPort([pr]);
    const after = await traceIssue({ issues, scm }, '7');
    expect(after.pullRequest?.id).toBe('pr-1');
    expect(after.checks?.id).toBe('pr-1');
    expect(after.missing.pullRequest).toBeUndefined();
    expect(after.missing.checks).toBeUndefined();
    expect(scm.calls).toEqual([`prForBranch ${BRANCH} all`, 'prStatus pr-1']);
  });

  it('joins CI runs and deployments on the branch, with the limits it promises', async () => {
    const issues = issuesPort({});
    const ci = ciPort({ [BRANCH]: ['r1', 'r2'] });
    const deploy = deployPort(['main', BRANCH, 'other']);
    const trace = await traceIssue({ issues, ci, deploy }, '7');
    expect(trace.runs?.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(ci.queries[0]).toEqual({ branch: BRANCH, limit: TRACE_RUN_LIMIT });
    expect(trace.deployment?.ref).toBe(BRANCH);
    expect(deploy.queries[0]).toEqual({ limit: TRACE_DEPLOYMENT_SCAN });

    const cold = await traceIssue({ issues, ci: ciPort({}), deploy: deployPort(['main']) }, '7');
    expect(cold.runs).toBeNull();
    expect(cold.missing.runs).toContain(BRANCH);
    expect(cold.deployment).toBeNull();
    expect(cold.missing.deployment).toContain('1 deployment(s)');
  });

  it('stops at the branch for a container, and says why', async () => {
    const issues = issuesPort({ typeRole: 'epic', nativeType: 'epic', branchName: undefined });
    const scm = scmPort([]);
    const trace = await traceIssue({ issues, scm }, '7');
    expect(trace.branch).toBeNull();
    expect(trace.missing.branch).toContain('container');
    expect(trace.missing.pullRequest).toBe('There is no branch to look up.');
    expect(scm.calls).toEqual([]);
  });

  it('is PORT_UNBOUND without an issues port', async () => {
    await expect(traceIssue({}, 'x')).rejects.toMatchObject({ code: 'PORT_UNBOUND' });
  });
});
