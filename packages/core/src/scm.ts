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
}

/** Native PR-create input the transport receives (abstract draft already gap-resolved). */
export interface NativePullRequestInput {
  readonly title: string;
  readonly body?: string | undefined;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly draft: boolean;
}

export interface NativeBranch {
  readonly name: string;
  readonly sha: string;
  readonly url?: string | undefined;
}

export interface NativePullRequest {
  readonly id: string;
  readonly number?: string | undefined;
  readonly title: string;
  readonly url?: string | undefined;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly draft: boolean;
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
export interface ScmTransport {
  createBranch(name: string, fromBranch: string): Promise<NativeBranch>;
  createPullRequest(input: NativePullRequestInput): Promise<NativePullRequest>;
  addPullRequestThread(pullRequestId: string, body: string): Promise<NativeThread>;
  /** The repository's default branch (e.g. 'main', 'release'), without a refs/heads/ prefix. */
  defaultBranch(): Promise<string>;
}

/** The normalized primitive surface the core exposes for the `scm` port. */
export interface ScmPort {
  readonly manifest: ScmManifest;
  createBranch(draft: BranchDraft): Promise<BranchRef>;
  createPullRequest(draft: PullRequestDraft): Promise<PullRequest>;
  addPullRequestThread(pullRequestId: string, body: string): Promise<PullRequestThread>;
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
    return { name: native.name, sha: native.sha, url: native.url };
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

    const targetBranch = draft.targetBranch ?? (await this.transport.defaultBranch());
    const native = await this.transport.createPullRequest({
      title: draft.title,
      body: draft.body,
      sourceBranch: draft.sourceBranch,
      targetBranch,
      draft: draftState,
    });

    return {
      id: native.id,
      number: native.number,
      title: native.title,
      url: native.url,
      sourceBranch: native.sourceBranch,
      targetBranch: native.targetBranch,
      draft: native.draft,
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
