import type { CiPort, Run } from './ci.js';
import type { DeployPort, Deployment } from './deploy.js';
import { BaronError } from './errors.js';
import type { Issue } from './issue.js';
import type { IssuesPort } from './ports.js';
import type { PullRequest, PullRequestStatus, ScmPort } from './scm.js';

/**
 * `trace`: where one work item is, end to end, in a single read.
 *
 * "Where is this item?" is a question that spans four ports — the tracker, the repository, CI and
 * deployments — and answering it by hand means four calls and knowing how they join. They join on
 * the one thing the core already derives: the item's canonical branch name. So this is a read
 * model over ports Baron already binds, not a new port: no adapter learns anything, and a port
 * that is not bound, or a hop the item has not reached, is reported by name rather than left out.
 */

export interface TracePorts {
  readonly issues?: IssuesPort | undefined;
  readonly scm?: ScmPort | undefined;
  readonly ci?: CiPort | undefined;
  readonly deploy?: DeployPort | undefined;
}

export const TRACE_PARTS = ['branch', 'pullRequest', 'checks', 'runs', 'deployment'] as const;
export type TracePart = (typeof TRACE_PARTS)[number];

/** How many recent CI runs on the branch are reported. */
export const TRACE_RUN_LIMIT = 5;
/** How many recent deployments are scanned for one that references the branch. */
export const TRACE_DEPLOYMENT_SCAN = 50;

export interface IssueTrace {
  readonly issue: Issue;
  /** The canonical branch the core derives for the item; null for a container or unmapped type. */
  readonly branch: string | null;
  /** The most recent pull request from that branch, in any state. */
  readonly pullRequest: PullRequest | null;
  /** That pull request's review decision, mergeability and checks. */
  readonly checks: PullRequestStatus | null;
  /** The most recent CI runs on the branch, newest first as the provider lists them. */
  readonly runs: readonly Run[] | null;
  /** The most recent deployment whose ref is the branch. */
  readonly deployment: Deployment | null;
  /**
   * Why a part is null — the port is not bound, or the item has not reached that hop. Every null
   * above has a line here (invariant 5: a gap is never silent).
   */
  readonly missing: Readonly<Partial<Record<TracePart, string>>>;
}

const SCM_UNBOUND = 'The scm port is not bound.';
const CI_UNBOUND = 'The ci port is not bound.';
const DEPLOY_UNBOUND = 'The deploy port is not bound.';
const NO_BRANCH = 'There is no branch to look up.';

export async function traceIssue(ports: TracePorts, id: string): Promise<IssueTrace> {
  if (ports.issues === undefined) {
    throw new BaronError('The issues port is not configured.', 'PORT_UNBOUND');
  }
  const issue = await ports.issues.get(id);
  const missing: Partial<Record<TracePart, string>> = {};
  const branch = issue.branchName ?? null;

  if (branch === null) {
    missing.branch =
      `${issue.key} has no canonical branch: its type '${issue.nativeType}' is a container ` +
      '(epic, initiative) or is not mapped to a type role.';
    missing.pullRequest = NO_BRANCH;
    missing.checks = NO_BRANCH;
    missing.runs = NO_BRANCH;
    missing.deployment = NO_BRANCH;
    return {
      issue,
      branch,
      pullRequest: null,
      checks: null,
      runs: null,
      deployment: null,
      missing,
    };
  }

  let pullRequest: PullRequest | null = null;
  let checks: PullRequestStatus | null = null;
  if (ports.scm === undefined) {
    missing.pullRequest = SCM_UNBOUND;
    missing.checks = SCM_UNBOUND;
  } else {
    // Any state: a merged PR is the most useful thing to know about a finished item.
    pullRequest = (await ports.scm.prForBranch(branch, 'all')) ?? null;
    if (pullRequest === null) {
      missing.pullRequest = `No pull request has been opened from ${branch}.`;
      missing.checks = 'There is no pull request to report checks for.';
    } else {
      checks = await ports.scm.prStatus(pullRequest.id);
    }
  }

  let runs: readonly Run[] | null = null;
  if (ports.ci === undefined) {
    missing.runs = CI_UNBOUND;
  } else {
    const found = await ports.ci.runs({ branch, limit: TRACE_RUN_LIMIT });
    if (found.length === 0) missing.runs = `No CI run has been recorded for ${branch}.`;
    else runs = found;
  }

  let deployment: Deployment | null = null;
  if (ports.deploy === undefined) {
    missing.deployment = DEPLOY_UNBOUND;
  } else {
    // Joined on the ref only: a deployment of the merge commit on the default branch carries that
    // branch's name, not this one's, and the core has no merge sha to match it by. Lossy, and said.
    const recent = await ports.deploy.deployments({ limit: TRACE_DEPLOYMENT_SCAN });
    deployment = recent.find((d) => d.ref === branch) ?? null;
    if (deployment === null) {
      missing.deployment =
        `None of the last ${recent.length} deployment(s) references ${branch} as its ref ` +
        '(a deployment of the merged commit is listed under the target branch, not here).';
    }
  }

  return { issue, branch, pullRequest, checks, runs, deployment, missing };
}
