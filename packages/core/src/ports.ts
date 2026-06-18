import type { CapabilityManifest } from './capabilities.js';
import type { IssuesProviderConfig, NativeTarget } from './config.js';
import { BaronError } from './errors.js';
import type { Issue, IssueDraft } from './issue.js';
import type { Logger } from './logger.js';
import { silentLogger } from './logger.js';
import { resolveGap } from './policy.js';
import { RoleResolver } from './role-resolver.js';
import type { WorkflowRole } from './roles.js';

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
  readonly url?: string | undefined;
}

export interface NativeCreateInput {
  readonly title: string;
  readonly body?: string | undefined;
  readonly nativeType: string;
  readonly parentId?: string | undefined;
  readonly labels: readonly string[];
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
}

/** The normalized primitive surface the core exposes for the `issues` port. */
export interface IssuesPort {
  readonly manifest: CapabilityManifest;
  create(draft: IssueDraft): Promise<Issue>;
  get(id: string): Promise<Issue>;
  transition(id: string, role: WorkflowRole): Promise<Issue>;
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

  private toIssue(native: NativeIssue): Issue {
    return {
      id: native.id,
      key: native.key,
      title: native.title,
      body: native.body,
      nativeType: native.nativeType,
      typeRole: this.reverseTypeRole(native.nativeType),
      role: this.resolver.toRole(native.discriminator),
      nativeState: native.discriminator,
      parentId: native.parentId,
      labels: native.labels,
      url: native.url,
      provider: this.cfg.provider,
    };
  }

  private reverseTypeRole(nativeType: string) {
    for (const [typeRole, name] of Object.entries(this.cfg.typeMap)) {
      if (name === nativeType) return typeRole as keyof typeof this.cfg.typeMap;
    }
    return undefined;
  }
}
