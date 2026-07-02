import { deriveBranchName } from './branch-name.js';
import type { CapabilityManifest } from './capabilities.js';
import type { IssuesProviderConfig, NativeTarget } from './config.js';
import { BaronError } from './errors.js';
import type { Issue, IssueComment, IssueDraft, IssueQuery } from './issue.js';
import type { IssueLinkType } from './links.js';
import type { Logger } from './logger.js';
import { silentLogger } from './logger.js';
import { resolveGap } from './policy.js';
import { RoleResolver } from './role-resolver.js';
import type { WorkItemTypeRole, WorkflowRole } from './roles.js';

/**
 * Deterministic tie-break for reverse type-role resolution when a flat provider maps several type
 * roles onto one native type: prefer the branchable, story-level reading over container types.
 */
const REVERSE_TYPE_ROLE_PRIORITY: readonly WorkItemTypeRole[] = [
  'story',
  'task',
  'bug',
  'subtask',
  'epic',
  'initiative',
];

/** A raw issue as a provider transport speaks it (before normalization to {@link Issue}). */
export interface NativeIssue {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly body?: string | undefined;
  readonly nativeType: string;
  /** The value used for reverse role lookup (Azure state, GitHub label-or-'closed'). */
  readonly discriminator: string;
  readonly parentId?: string | undefined;
  readonly labels: readonly string[];
  /** Provider-native user handle of the assignee (Azure: email; GitHub: login), if any. */
  readonly assignee?: string | undefined;
  readonly url?: string | undefined;
}

export interface NativeCreateInput {
  readonly title: string;
  readonly body?: string | undefined;
  readonly nativeType: string;
  readonly parentId?: string | undefined;
  readonly labels: readonly string[];
}

/** A raw comment as a provider transport speaks it (before normalization to {@link IssueComment}). */
export interface NativeComment {
  readonly id: string;
  readonly body: string;
  readonly author?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly url?: string | undefined;
}

/**
 * A query the transport executes, expressed in already-translated native terms: `target` is the
 * role's native discriminator (the transport reads its own key, e.g. state or label), `nativeType`
 * the work-item type. The role→native translation happened in {@link BaseIssuesAdapter}.
 */
export interface NativeQuery {
  readonly target?: NativeTarget | undefined;
  readonly nativeType?: string | undefined;
  readonly limit?: number | undefined;
}

/**
 * The thin, provider-specific transport an adapter delegates I/O to. Real implementations call
 * the vendor SDK; tests pass an in-memory fake. Keeping this separate from the translation logic
 * is what makes the conformance suite runnable without network access.
 */
export interface IssuesTransport {
  createIssue(input: NativeCreateInput): Promise<NativeIssue>;
  getIssue(id: string): Promise<NativeIssue>;
  applyTarget(id: string, target: NativeTarget): Promise<NativeIssue>;
  /** Add a label additively WITHOUT touching the role discriminator (used by link emulation). */
  addLabel(id: string, label: string): Promise<void>;
  addComment(id: string, body: string): Promise<NativeComment>;
  /** Create a native typed link. Only called when the manifest declares `issueLinks`. */
  linkIssues(fromId: string, toId: string, nativeLinkType: string): Promise<void>;
  queryIssues(query: NativeQuery): Promise<readonly NativeIssue[]>;
  /** Assign to a provider-native user handle. Only called when the manifest declares `assignment`. */
  assignIssue(id: string, assignee: string): Promise<NativeIssue>;
}

/** The normalized primitive surface the core exposes for the `issues` port. */
export interface IssuesPort {
  readonly manifest: CapabilityManifest;
  create(draft: IssueDraft): Promise<Issue>;
  get(id: string): Promise<Issue>;
  transition(id: string, role: WorkflowRole): Promise<Issue>;
  comment(id: string, body: string): Promise<IssueComment>;
  link(fromId: string, toId: string, type: IssueLinkType): Promise<void>;
  query(filter: IssueQuery): Promise<readonly Issue[]>;
  /** Assign the issue to a provider-native user handle (Azure: email; GitHub: login). */
  assign(id: string, assignee: string): Promise<Issue>;
}

/**
 * Provider-agnostic implementation of the `issues` primitives. All impedance handling lives here:
 * role<->native translation via {@link RoleResolver}, and capability-gap negotiation via the gap
 * policy. A concrete adapter supplies only a {@link CapabilityManifest} and an
 * {@link IssuesTransport}; it writes no translation logic of its own.
 */
export class BaseIssuesAdapter implements IssuesPort {
  private readonly resolver: RoleResolver;

  constructor(
    readonly manifest: CapabilityManifest,
    private readonly cfg: IssuesProviderConfig,
    private readonly transport: IssuesTransport,
    private readonly logger: Logger = silentLogger,
  ) {
    this.resolver = new RoleResolver(cfg.roleMap, cfg.provider);
  }

  async create(draft: IssueDraft): Promise<Issue> {
    const nativeType = this.cfg.typeMap[draft.typeRole];
    if (nativeType === undefined) {
      throw new BaronError(
        `No native type mapping for type role '${draft.typeRole}' on provider ` +
          `'${this.cfg.provider}'. Add it to policy.typeMap.`,
        'TYPE_MAPPING',
      );
    }

    const labels = [...(draft.labels ?? [])];
    let nativeParentId: string | undefined;

    if (draft.parentId !== undefined) {
      const { behavior } = resolveGap('hierarchy', this.manifest, this.cfg.gapPolicy, this.logger);
      if (this.manifest.issues.hierarchy) {
        nativeParentId = draft.parentId;
      } else if (behavior.kind === 'emulate') {
        if (behavior.strategy === 'labels') {
          labels.push(`parent:${draft.parentId}`);
        } else {
          throw new BaronError(
            `Unsupported hierarchy emulation strategy '${behavior.strategy}' for provider ` +
              `'${this.cfg.provider}'. Supported: 'labels'.`,
            'GAP_STRATEGY',
          );
        }
      }
      // 'degrade' intentionally drops the parent; resolveGap already logged a warning.
    }

    const created = await this.transport.createIssue({
      title: draft.title,
      body: draft.body,
      nativeType,
      parentId: nativeParentId,
      labels,
    });

    if (draft.initialRole !== undefined) {
      return this.transition(created.id, draft.initialRole);
    }
    return this.toIssue(created);
  }

  async get(id: string): Promise<Issue> {
    return this.toIssue(await this.transport.getIssue(id));
  }

  async transition(id: string, role: WorkflowRole): Promise<Issue> {
    const target = this.resolver.toNative(role);

    const needsEmulatedState =
      !this.manifest.issues.arbitraryStates && role !== 'done' && role !== 'backlog';
    if (needsEmulatedState) {
      resolveGap('arbitraryStates', this.manifest, this.cfg.gapPolicy, this.logger);
    }

    return this.toIssue(await this.transport.applyTarget(id, target));
  }

  async comment(id: string, body: string): Promise<IssueComment> {
    if (!this.manifest.issues.comments) {
      resolveGap('comments', this.manifest, this.cfg.gapPolicy, this.logger);
    }
    const native = await this.transport.addComment(id, body);
    return {
      id: native.id,
      body: native.body,
      author: native.author,
      createdAt: native.createdAt,
      url: native.url,
    };
  }

  async link(fromId: string, toId: string, type: IssueLinkType): Promise<void> {
    if (this.manifest.issues.issueLinks) {
      const nativeLinkType = this.cfg.linkMap?.[type];
      if (nativeLinkType === undefined) {
        throw new BaronError(
          `No native link mapping for link type '${type}' on provider '${this.cfg.provider}'. ` +
            'Add it to the adapter link map.',
          'LINK_MAPPING',
        );
      }
      await this.transport.linkIssues(fromId, toId, nativeLinkType);
      return;
    }

    const { behavior } = resolveGap('issueLinks', this.manifest, this.cfg.gapPolicy, this.logger);
    if (behavior.kind === 'emulate') {
      if (behavior.strategy === 'labels') {
        // Encode the link as an additive label on the source issue. Uses addLabel (not applyTarget)
        // so it never overwrites the workflow-role discriminator on label-keyed providers.
        await this.transport.addLabel(fromId, `${type}:${toId}`);
      } else {
        throw new BaronError(
          `Unsupported issueLinks emulation strategy '${behavior.strategy}' for provider ` +
            `'${this.cfg.provider}'. Supported: 'labels'.`,
          'GAP_STRATEGY',
        );
      }
    }
    // 'degrade' intentionally drops the link; resolveGap already logged a warning.
  }

  async assign(id: string, assignee: string): Promise<Issue> {
    if (!this.manifest.issues.assignment) {
      resolveGap('assignment', this.manifest, this.cfg.gapPolicy, this.logger);
      // 'degrade' reaches here: the assignment is intentionally dropped (warned), return unchanged.
      return this.get(id);
    }
    return this.toIssue(await this.transport.assignIssue(id, assignee));
  }

  async query(filter: IssueQuery): Promise<readonly Issue[]> {
    const nativeType =
      filter.typeRole === undefined ? undefined : this.cfg.typeMap[filter.typeRole];
    if (filter.typeRole !== undefined && nativeType === undefined) {
      throw new BaronError(
        `No native type mapping for type role '${filter.typeRole}' on provider ` +
          `'${this.cfg.provider}'. Add it to policy.typeMap.`,
        'TYPE_MAPPING',
      );
    }
    const query = {
      ...(filter.role !== undefined ? { target: this.resolver.toNative(filter.role) } : {}),
      ...(nativeType !== undefined ? { nativeType } : {}),
      ...(filter.limit !== undefined ? { limit: filter.limit } : {}),
    };
    const natives = await this.transport.queryIssues(query);
    return natives.map((native) => this.toIssue(native));
  }

  private toIssue(native: NativeIssue): Issue {
    const typeRole = this.reverseTypeRole(native.nativeType);
    return {
      id: native.id,
      key: native.key,
      title: native.title,
      body: native.body,
      nativeType: native.nativeType,
      typeRole,
      role: this.resolver.toRole(native.discriminator),
      nativeState: native.discriminator,
      parentId: native.parentId,
      labels: native.labels,
      assignee: native.assignee,
      branchName: deriveBranchName({ id: native.id, title: native.title, typeRole }),
      url: native.url,
      provider: this.cfg.provider,
    };
  }

  private reverseTypeRole(nativeType: string) {
    const candidates = Object.entries(this.cfg.typeMap)
      .filter(([, name]) => name === nativeType)
      .map(([typeRole]) => typeRole as keyof typeof this.cfg.typeMap);
    if (candidates.length <= 1) return candidates[0];
    // A flat provider collapses several type roles onto one native type (GitHub: everything ->
    // 'issue'), making the reverse lookup ambiguous. Tie-break deterministically, preferring the
    // branchable story-level reading over containers — insertion order would be arbitrary and
    // could resolve every issue to 'initiative', which (correctly) has no branch prefix.
    return REVERSE_TYPE_ROLE_PRIORITY.find((role) => candidates.includes(role)) ?? candidates[0];
  }
}
