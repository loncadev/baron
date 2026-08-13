import { type Logger, silentLogger } from './logger.js';
import { type GapPolicy, resolveCapabilityGap } from './policy.js';

/**
 * What an `scm` adapter supports. Like the issues capabilities, the core consults this before an
 * operation and applies the gap policy for anything `false`. Source control is more uniform across
 * providers than issue tracking, so this set is small — but the manifest + gap pattern is the same.
 */
export interface ScmCapabilities {
  /** Pull requests can be opened in a draft state. */
  draftPullRequests: boolean;
  /** First-class PR discussion threads (vs. only a flat PR-level comment). */
  pullRequestThreads: boolean;
  /**
   * A pull request can carry ASSIGNEES — who owns getting it merged. GitHub has them (a PR is an
   * issue); Azure Repos does not (it has reviewers, a different role), so it negotiates the gap.
   */
  pullRequestAssignees: boolean;
  /**
   * "Merge it for me once the checks/policies pass" — Azure calls it auto-complete, GitHub calls it
   * auto-merge. Same semantic, so Baron exposes one switch.
   */
  autoComplete: boolean;
}

export type ScmCapabilityName = keyof ScmCapabilities;

/** Self-description an `scm` adapter exposes so the core can negotiate gaps. */
export interface ScmManifest {
  provider: string;
  scm: ScmCapabilities;
}

/** A normalized branch reference, independent of the backing provider. */
export interface BranchRef {
  readonly name: string;
  readonly sha: string;
  readonly url?: string | undefined;
  /**
   * False when the branch already existed and was returned as-is (a resume). Lets a caller tell a
   * real creation from a no-op — e.g. only announce "branch created" on the run that created it.
   */
  readonly created: boolean;
}

/** A normalized pull request, independent of the backing provider. */
export interface PullRequest {
  readonly id: string;
  /** Human-facing number where the provider has one (GitHub #N); may equal id. */
  readonly number?: string | undefined;
  readonly title: string;
  readonly url?: string | undefined;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly draft: boolean;
  /** Lifecycle state; populated by `prForBranch` (a freshly created PR is always `open`). */
  readonly state?: PrState | undefined;
  /**
   * Whether auto-complete/auto-merge was actually enabled, when it was requested. False means the
   * provider refused (e.g. GitHub repos with "Allow auto-merge" off) — reported, never silent.
   */
  readonly autoCompleteEnabled?: boolean | undefined;
}

/** A normalized PR discussion thread reference. */
export interface PullRequestThread {
  readonly id: string;
  readonly url?: string | undefined;
}

/** Input to `scm.branch.create`. */
export interface BranchDraft {
  readonly name: string;
  /** Existing branch to fork from. Defaults to the repository's default branch when omitted. */
  readonly fromBranch?: string | undefined;
}

/** Input to `scm.pr.create`. */
export interface PullRequestDraft {
  readonly title: string;
  readonly body?: string | undefined;
  readonly sourceBranch: string;
  /** Branch to merge into. Defaults to the repository's default branch when omitted. */
  readonly targetBranch?: string | undefined;
  readonly draft?: boolean | undefined;
  /**
   * The work item this PR implements. The adapter renders the provider's NATIVE linking syntax
   * (GitHub `Closes #12`, Azure `AB#12`) so the tracker actually associates the two — a comment
   * carrying a URL is not a link. Abstract here on purpose: recipes never spell a vendor's keyword.
   */
  readonly linkedIssueKey?: string | undefined;
  /**
   * Who owns this PR. Accepts the '@me' sentinel like the issues port, so a recipe can say "assign it
   * to whoever ran this" without knowing a handle. Negotiated where PRs have no assignees (Azure).
   */
  readonly assignees?: readonly string[] | undefined;
  /** Merge automatically once checks/policies pass (Azure auto-complete / GitHub auto-merge). */
  readonly autoComplete?: boolean | undefined;
}

/** Native PR-create input the transport receives (abstract draft already gap-resolved). */
export interface NativePullRequestInput {
  readonly title: string;
  readonly body?: string | undefined;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly draft: boolean;
  /** Work item to link natively; the transport renders its provider's keyword into the body. */
  readonly linkedIssueKey?: string | undefined;
  /** Resolved assignees (the port already turned '@me' into a handle); empty when unsupported. */
  readonly assignees?: readonly string[] | undefined;
  /** Enable the provider's auto-complete / auto-merge; only set when the manifest declares it. */
  readonly autoComplete?: boolean | undefined;
}

export interface NativeBranch {
  readonly name: string;
  readonly sha: string;
  readonly url?: string | undefined;
  /** True when this call created the ref; false when it already existed (idempotent no-op). */
  readonly created: boolean;
}

export interface NativePullRequest {
  readonly id: string;
  readonly number?: string | undefined;
  readonly title: string;
  readonly url?: string | undefined;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly draft: boolean;
  /** Lifecycle state; set by `findPullRequestByBranch` so callers needn't a second status read. */
  readonly state?: PrState | undefined;
  /**
   * Whether auto-complete/auto-merge was actually enabled, when it was requested. False means the
   * provider refused (e.g. GitHub repos with "Allow auto-merge" off) — reported, never silent.
   */
  readonly autoCompleteEnabled?: boolean | undefined;
}

export interface NativeThread {
  readonly id: string;
  readonly url?: string | undefined;
}

/**
 * The thin, provider-specific transport an `scm` adapter delegates I/O to. Real implementations call
 * the vendor SDK; tests pass an in-memory fake — the same separation that keeps the conformance
 * suite network-free.
 */
/** Normalized PR lifecycle state. */
export const PR_STATES = ['open', 'merged', 'closed', 'unknown'] as const;
export type PrState = (typeof PR_STATES)[number];

/**
 * The lifecycle filter `prForBranch` searches by. `open` (default) powers finish-flow idempotency
 * (don't duplicate an open PR); `merged` powers drift detection (did this branch's work land while
 * its item stayed in progress?); `all` returns the most recent PR regardless of state.
 */
export const PR_STATE_FILTERS = ['open', 'merged', 'closed', 'all'] as const;
export type PrStateFilter = (typeof PR_STATE_FILTERS)[number];

export function isPrStateFilter(value: string): value is PrStateFilter {
  return (PR_STATE_FILTERS as readonly string[]).includes(value);
}

/**
 * How a merge lands. Every provider offers these three; the adapter maps them onto its own names
 * (Azure's GitPullRequestMergeStrategy enum, GitHub's merge_method).
 */
export const MERGE_STRATEGIES = ['merge', 'squash', 'rebase'] as const;
export type MergeStrategy = (typeof MERGE_STRATEGIES)[number];

export function isMergeStrategy(value: string): value is MergeStrategy {
  return (MERGE_STRATEGIES as readonly string[]).includes(value);
}

/** How to land a pull request. */
export interface MergeOptions {
  /** Defaults to the provider's own default when omitted. */
  readonly strategy?: MergeStrategy | undefined;
  /** Delete the source branch after a successful merge. */
  readonly deleteSourceBranch?: boolean | undefined;
}

/** The outcome of landing a PR. */
export interface MergeResult {
  readonly pullRequestId: string;
  /** The merge commit, when the provider reports one. */
  readonly sha?: string | undefined;
}

/** Normalized review decision across providers (Azure reviewer votes / GitHub review states). */
export const REVIEW_DECISIONS = [
  'approved',
  'changes_requested',
  'review_required',
  'pending',
  'unknown',
] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/**
 * Normalized rollup of a PR's checks (CI/policy validations).
 *
 * `none` and `unknown` are NOT interchangeable and conflating them is a safety bug: `none` means the
 * provider was asked and reports no checks at all — nothing can go red, so merging is unblocked.
 * `unknown` means Baron could not find out (the credential cannot read them, the provider does not
 * expose them). A caller that treats `unknown` as `none` merges on the assumption that green is
 * green when nothing was ever looked at.
 */
export const CHECK_ROLLUPS = ['succeeded', 'failed', 'pending', 'none', 'unknown'] as const;
export type CheckRollup = (typeof CHECK_ROLLUPS)[number];

export interface CheckSummary {
  /** Checks actually counted. Always 0 for `none`; may be partial when the view was incomplete. */
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly pending: number;
  readonly rollup: CheckRollup;
  /**
   * Sources that did not contribute — refused by the credential, or not read by this adapter.
   * Present whenever the view was incomplete, so a caller can tell "this token may not look" from
   * "the integration is broken". Without it an unexplained `unknown` reads as a Baron bug, which
   * cost a real investigation before this field existed.
   */
  readonly unreadable?: readonly string[] | undefined;
  /**
   * What the caller can do about an incomplete view, in the provider's own terms — a permission to
   * grant, or the fact that this adapter does not read that source yet.
   *
   * Provider knowledge, so the provider supplies it. A recipe telling an Azure user to grant
   * "Actions (Read)" is worse than saying nothing: those permissions do not exist there, the rollup
   * is unknown on every Azure pull request, and an unactionable warning that fires every time is one
   * people learn to skip — which is how you lose the one that matters.
   */
  readonly remedy?: string | undefined;
}

/**
 * A normalized pull-request status — the "is this PR ready to merge?" view (scm monitoring). The
 * review/check aggregation is irreducibly provider-specific (Azure reviewer votes + policy vs GitHub
 * review states + checks), so each adapter computes it; the shape is uniform.
 */
export interface PullRequestStatus {
  readonly id: string;
  readonly state: PrState;
  readonly reviewDecision: ReviewDecision;
  /** Whether the PR can merge cleanly; undefined when the provider hasn't computed it. */
  readonly mergeable?: boolean | undefined;
  readonly checks: CheckSummary;
  readonly url?: string | undefined;
}

export interface ScmTransport {
  /**
   * Create the branch and return it. **Idempotent**: if a branch of that name already exists, return
   * the existing ref instead of failing — a resumed task-start (branch cut on a prior run) must flow
   * on to the transition/assign steps, not abort at branch creation.
   */
  createBranch(name: string, fromBranch: string): Promise<NativeBranch>;
  createPullRequest(input: NativePullRequestInput): Promise<NativePullRequest>;
  addPullRequestThread(pullRequestId: string, body: string): Promise<NativeThread>;
  /** The repository's default branch (e.g. 'main', 'release'), without a refs/heads/ prefix. */
  defaultBranch(): Promise<string>;
  /** Normalized PR status (state + review decision + mergeability + checks rollup). */
  getPullRequestStatus(pullRequestId: string): Promise<PullRequestStatus>;
  /** Take a draft PR out of draft so reviewers are asked / policies start (GitHub "ready for review"). */
  markPullRequestReady(pullRequestId: string): Promise<NativePullRequest>;
  /**
   * Land the PR. A provider that refuses (conflicts, unmet policy, already closed) must throw rather
   * than report success — a merge that silently didn't happen is the worst possible lie.
   */
  mergePullRequest(pullRequestId: string, options: MergeOptions): Promise<MergeResult>;
  /**
   * The most recent PR whose source is `sourceBranch` and whose state matches `stateFilter`, or
   * undefined when none. The transport sets the returned PR's `state`.
   */
  findPullRequestByBranch(
    sourceBranch: string,
    stateFilter: PrStateFilter,
  ): Promise<NativePullRequest | undefined>;
}

/** The normalized primitive surface the core exposes for the `scm` port. */
export interface ScmPort {
  readonly manifest: ScmManifest;
  /** Create (or, if it already exists, return) the branch — idempotent, so start/resume re-runs safely. */
  createBranch(draft: BranchDraft): Promise<BranchRef>;
  createPullRequest(draft: PullRequestDraft): Promise<PullRequest>;
  addPullRequestThread(pullRequestId: string, body: string): Promise<PullRequestThread>;
  /** Read a PR's normalized status (scm monitoring): state, review decision, mergeability, checks. */
  prStatus(pullRequestId: string): Promise<PullRequestStatus>;
  /** Take a draft PR out of draft. task-finish opens drafts deliberately; this is how you land-ready it. */
  markPrReady(pullRequestId: string): Promise<PullRequest>;
  /** Merge the PR (the last mile of the flow: create → start → PR → land). Throws if refused. */
  mergePr(pullRequestId: string, options?: MergeOptions): Promise<MergeResult>;
  /**
   * The most recent PR for a source branch matching `stateFilter` (default `open`), with its `state`
   * populated; undefined when none. `open` is the finish-flow idempotency probe (don't duplicate an
   * open PR); `merged` is the drift probe (did this branch land while its item stayed in progress?).
   */
  prForBranch(sourceBranch: string, stateFilter?: PrStateFilter): Promise<PullRequest | undefined>;
}

/**
 * Provider-agnostic implementation of the `scm` primitives. Capability-gap negotiation lives here
 * (e.g. a `draft` PR requested on a provider that lacks draft support is degraded or errored per
 * policy, never silently downgraded). A concrete adapter supplies only a {@link ScmManifest} and an
 * {@link ScmTransport}.
 */
export class BaseScmAdapter implements ScmPort {
  constructor(
    readonly manifest: ScmManifest,
    private readonly transport: ScmTransport,
    private readonly gapPolicy: GapPolicy = {},
    private readonly logger: Logger = silentLogger,
  ) {}

  async createBranch(draft: BranchDraft): Promise<BranchRef> {
    // A recipe should never have to hardcode the base branch (it varies per repo: main / release /
    // master); fall back to the provider's default branch so recipes stay portable (decision #4).
    const fromBranch = draft.fromBranch ?? (await this.transport.defaultBranch());
    const native = await this.transport.createBranch(draft.name, fromBranch);
    return { name: native.name, sha: native.sha, url: native.url, created: native.created };
  }

  async createPullRequest(draft: PullRequestDraft): Promise<PullRequest> {
    let draftState = draft.draft ?? false;
    if (draftState && !this.manifest.scm.draftPullRequests) {
      // Provider can't open a draft PR: negotiate rather than silently opening a ready PR.
      resolveCapabilityGap(
        false,
        'draftPullRequests',
        this.manifest.provider,
        this.gapPolicy,
        this.logger,
      );
      // 'error' already threw; 'degrade'/'emulate' proceed as a non-draft PR (warning logged).
      draftState = false;
    }

    // Assignees and auto-complete each exist on one provider and not the other, so both are
    // negotiated rather than silently dropped: 'error' throws, 'degrade'/'emulate' proceed without
    // the feature after resolveCapabilityGap has logged a warning (invariant #5).
    let assignees = draft.assignees;
    if (
      assignees !== undefined &&
      assignees.length > 0 &&
      !this.manifest.scm.pullRequestAssignees
    ) {
      resolveCapabilityGap(
        false,
        'pullRequestAssignees',
        this.manifest.provider,
        this.gapPolicy,
        this.logger,
      );
      assignees = undefined;
    }
    let autoComplete = draft.autoComplete;
    if (autoComplete === true && !this.manifest.scm.autoComplete) {
      resolveCapabilityGap(
        false,
        'autoComplete',
        this.manifest.provider,
        this.gapPolicy,
        this.logger,
      );
      autoComplete = undefined;
    }

    const targetBranch = draft.targetBranch ?? (await this.transport.defaultBranch());
    const native = await this.transport.createPullRequest({
      title: draft.title,
      body: draft.body,
      sourceBranch: draft.sourceBranch,
      targetBranch,
      draft: draftState,
      linkedIssueKey: draft.linkedIssueKey,
      assignees,
      autoComplete,
    });

    return {
      id: native.id,
      number: native.number,
      title: native.title,
      url: native.url,
      sourceBranch: native.sourceBranch,
      targetBranch: native.targetBranch,
      draft: native.draft,
      // A freshly created PR is open by definition — surface it uniformly with prForBranch results.
      state: 'open',
      autoCompleteEnabled: native.autoCompleteEnabled,
    };
  }

  async markPrReady(pullRequestId: string): Promise<PullRequest> {
    const native = await this.transport.markPullRequestReady(pullRequestId);
    return this.toPullRequest(native);
  }

  mergePr(pullRequestId: string, options: MergeOptions = {}): Promise<MergeResult> {
    // No gap negotiation: every provider can merge. A refusal (conflict, unmet policy) surfaces as
    // the transport's error, which is exactly what the caller must see.
    return this.transport.mergePullRequest(pullRequestId, options);
  }

  async prStatus(pullRequestId: string): Promise<PullRequestStatus> {
    // Aggregation is provider-specific (votes/policy vs reviews/checks), so the transport computes
    // the normalized status; the base simply delegates.
    return this.transport.getPullRequestStatus(pullRequestId);
  }

  private toPullRequest(native: NativePullRequest): PullRequest {
    return {
      id: native.id,
      number: native.number,
      title: native.title,
      url: native.url,
      sourceBranch: native.sourceBranch,
      targetBranch: native.targetBranch,
      draft: native.draft,
      state: native.state,
      autoCompleteEnabled: native.autoCompleteEnabled,
    };
  }

  async prForBranch(
    sourceBranch: string,
    stateFilter: PrStateFilter = 'open',
  ): Promise<PullRequest | undefined> {
    const native = await this.transport.findPullRequestByBranch(sourceBranch, stateFilter);
    if (native === undefined) return undefined;
    return {
      id: native.id,
      number: native.number,
      title: native.title,
      url: native.url,
      sourceBranch: native.sourceBranch,
      targetBranch: native.targetBranch,
      draft: native.draft,
      state: native.state,
    };
  }

  async addPullRequestThread(pullRequestId: string, body: string): Promise<PullRequestThread> {
    if (!this.manifest.scm.pullRequestThreads) {
      // Provider lacks first-class PR threads: negotiate rather than failing with a raw error.
      resolveCapabilityGap(
        false,
        'pullRequestThreads',
        this.manifest.provider,
        this.gapPolicy,
        this.logger,
      );
    }
    const native = await this.transport.addPullRequestThread(pullRequestId, body);
    return { id: native.id, url: native.url };
  }
}
