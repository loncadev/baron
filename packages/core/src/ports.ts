import { deriveBranchName } from './branch-name.js';
import type { CapabilityManifest } from './capabilities.js';
import type { IssuesProviderConfig, LabelSpec, NativeTarget } from './config.js';
import { BaronError } from './errors.js';
import type { Issue, IssueComment, IssueDraft, IssueQuery } from './issue.js';
import { ITERATION_CURRENT, type Iteration } from './iteration.js';
import type { IssueLinkType } from './links.js';
import type { Logger } from './logger.js';
import { silentLogger } from './logger.js';
import { resolveCapabilityGap, resolveGap } from './policy.js';
import { RoleResolver } from './role-resolver.js';
import {
  BLOCKED_LABEL,
  type RoleMove,
  type WorkItemTypeRole,
  type WorkflowRole,
  classifyRoleMove,
  isWorkItemTypeRole,
} from './roles.js';

/** What {@link IssuesPort.classifyMove} answers: the move's kind, and the roles it is between. */
export interface RoleMoveResult {
  readonly kind: RoleMove;
  /** The item's current role; absent when it could not be read (then `kind` is `unknown`). */
  readonly from?: WorkflowRole | undefined;
  readonly to: WorkflowRole;
}

/**
 * Prefix of the label that carries a work-item TYPE ROLE on providers whose native types are flat
 * (GitHub: every type role maps onto one `issue`). Without it the role cannot be recovered from the
 * native type — a bug reads back as a story. Mirrors the `parent:<id>` hierarchy-emulation label.
 */
export const TYPE_ROLE_LABEL_PREFIX = 'type:';

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
  /** The item's iteration/sprint path, when the provider has sprints. */
  readonly iteration?: string | undefined;
  readonly url?: string | undefined;
}

export interface NativeCreateInput {
  readonly title: string;
  readonly body?: string | undefined;
  readonly nativeType: string;
  /** The abstract type role, so an adapter can route to a type-specific native field (Bug repro). */
  readonly typeRole: WorkItemTypeRole;
  readonly parentId?: string | undefined;
  readonly labels: readonly string[];
}

/** Fields an edit may change. Omitted keys are left untouched — this is a patch, not a replace. */
export interface IssueUpdate {
  readonly title?: string | undefined;
  readonly body?: string | undefined;
}

/** Native edit input: the patch plus the item's resolved type role, so the body lands in the
 * type's native field (a bug's body is its repro steps). The base adapter resolves the role — an
 * adapter never reverses it itself (invariant #4). Undefined when the provider's type is ambiguous. */
export interface NativeUpdateInput extends IssueUpdate {
  readonly typeRole?: WorkItemTypeRole | undefined;
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
  /** Provider-native user handle, or the '@me' sentinel the transport resolves natively. */
  readonly assignee?: string | undefined;
  /** Resolved iteration path (the '@current' sentinel is resolved to a path before this). */
  readonly iterationPath?: string | undefined;
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
  /**
   * Remove a label. Only providers whose roles ride labels need it — the base adapter calls it to
   * clear the PREVIOUS role's label on a transition, so an item never carries two at once.
   */
  removeLabel?(id: string, label: string): Promise<void>;
  /**
   * Create the given labels if they don't already exist (idempotent). Only providers whose roles ride
   * labels (GitHub) implement it; on native-state providers (Azure) it is absent and the base adapter
   * no-ops. Lets Baron provision role labels deliberately instead of relying on grey auto-creation.
   */
  ensureLabels?(labels: readonly LabelSpec[]): Promise<void>;
  addComment(id: string, body: string): Promise<NativeComment>;
  /** Create a native typed link. Only called when the manifest declares `issueLinks`. */
  linkIssues(fromId: string, toId: string, nativeLinkType: string): Promise<void>;
  queryIssues(query: NativeQuery): Promise<readonly NativeIssue[]>;
  /** Apply a field patch (title/body). Only the provided keys change. */
  updateIssue(id: string, update: NativeUpdateInput): Promise<NativeIssue>;
  /** Assign to a provider-native user handle. Only called when the manifest declares `assignment`. */
  assignIssue(id: string, assignee: string): Promise<NativeIssue>;
  /**
   * The token owner's native handle — what `@me` resolves to. MUST be the same form the transport
   * reports in {@link NativeIssue.assignee}, so `assign('@me')` followed by a read compares equal;
   * ownership checks ("is this item mine?") depend on that round-trip holding.
   */
  currentUser(): Promise<string>;
  /** The provider's iterations/sprints. Only called when the manifest declares `sprints`. */
  listIterations(): Promise<readonly Iteration[]>;
  /** Move an item to an iteration by path. Only called when the manifest declares `sprints`. */
  setIteration(id: string, iterationPath: string): Promise<NativeIssue>;
}

/** The normalized primitive surface the core exposes for the `issues` port. */
export interface IssuesPort {
  readonly manifest: CapabilityManifest;
  create(draft: IssueDraft): Promise<Issue>;
  get(id: string): Promise<Issue>;
  /**
   * Edit an existing item's title/body. A patch: omitted fields are left alone. The body lands in
   * the field the item's type uses (a bug's body is its repro steps), same as on create.
   */
  update(id: string, update: IssueUpdate): Promise<Issue>;
  /** The caller's own handle (what `@me` resolves to) — lets a recipe ask "is this item mine?". */
  whoAmI(): Promise<string>;
  transition(id: string, role: WorkflowRole): Promise<Issue>;
  /**
   * What moving this item to `role` would BE — advance, regress, reopen, noop — without moving it.
   *
   * Read-only, and deliberately a fact rather than a judgement: the lifecycle order is core
   * vocabulary, while "a regress needs a recorded reason" is workflow opinion that belongs in a
   * recipe. Without this a recipe could not tell the two apart at all: the condition grammar has
   * truthy/falsy/equals/notEquals and no way to compare positions in an order.
   */
  classifyMove(id: string, role: WorkflowRole): Promise<RoleMoveResult>;
  /**
   * Set the orthogonal blocked flag with a reason, leaving the workflow role alone. Separate from
   * `transition` on purpose: "can it move?" and "where is it?" are different questions, and folding
   * them together is what made unblocking have nowhere to return to.
   */
  block(id: string, reason: string): Promise<Issue>;
  /** Clear the blocked flag, optionally recording why. The role is untouched. */
  unblock(id: string, reason?: string): Promise<Issue>;
  /**
   * Bring emulated role labels back in line with the state the provider reports. Commands no role —
   * it only clears an emulation the provider's own state contradicts, so it is safe to call after
   * any operation that may have changed an item outside Baron (a merge that closes its issue).
   */
  reconcile(id: string): Promise<Issue>;
  comment(id: string, body: string): Promise<IssueComment>;
  link(fromId: string, toId: string, type: IssueLinkType): Promise<void>;
  query(filter: IssueQuery): Promise<readonly Issue[]>;
  /** Assign the issue to a provider-native user handle (Azure: email; GitHub: login). */
  assign(id: string, assignee: string): Promise<Issue>;
  /**
   * Provision the given labels (idempotent). A no-op on providers whose roles are native states.
   * `baron init` calls this to create a repo's workflow labels deliberately (named colors) so a
   * transition never depends on the provider silently auto-creating a grey one.
   */
  ensureLabels(labels: readonly LabelSpec[]): Promise<void>;
  /** The provider's iterations/sprints (empty when the provider has none). */
  iterations(): Promise<readonly Iteration[]>;
  /** The active iteration right now, or undefined (no sprint active / provider has none). */
  currentIteration(): Promise<Iteration | undefined>;
  /** Move the item to an iteration path, or {@link ITERATION_CURRENT} for the active sprint. */
  setIteration(id: string, iteration: string): Promise<Issue>;
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
    // Carry the role on a label unless the native type can carry it back on its own — which needs
    // BOTH that the provider stores a type at all and that this one names a single role. GitHub
    // fails the first (`issues.create` takes no type, so everything reads back untyped) and the
    // label is the only thing keeping `create({typeRole:'bug'})` readable as a bug, and its branch
    // prefix honest (bug/… not feature/…). Asking only the second question silently dropped the
    // label the moment a type map stopped collapsing every role onto one native type.
    const nativeTypeCarriesRole =
      this.manifest.issues.nativeTypes && !this.isAmbiguousNativeType(nativeType);
    if (this.manifest.issues.nativeLabels && !nativeTypeCarriesRole) {
      labels.push(`${TYPE_ROLE_LABEL_PREFIX}${draft.typeRole}`);
    }
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
      typeRole: draft.typeRole,
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

  /**
   * Mark the item blocked, leaving its workflow role exactly where it is. The reason is posted as a
   * comment first, so the record of WHY survives on the item rather than in whoever ran it — and it
   * lands before the flag, so an item is never seen blocked with no explanation. Idempotent.
   */
  async block(id: string, reason: string): Promise<Issue> {
    if (reason.trim().length === 0) {
      throw new BaronError(
        'Blocking needs a reason — an item blocked for no recorded reason is one nobody can unblock.',
        'BLOCK_REASON_REQUIRED',
      );
    }
    this.requireBlockedFlag();
    const before = await this.transport.getIssue(id);
    if (before.labels.includes(BLOCKED_LABEL)) return this.toIssue(before);
    await this.transport.addComment(id, `⛔ Blocked: ${reason}`);
    await this.transport.addLabel(id, BLOCKED_LABEL);
    return this.get(id);
  }

  /** Clear the blocked flag. The role is untouched, so work resumes where it actually was. */
  async unblock(id: string, reason?: string): Promise<Issue> {
    this.requireBlockedFlag();
    const before = await this.transport.getIssue(id);
    if (!before.labels.includes(BLOCKED_LABEL)) return this.toIssue(before);
    if (reason !== undefined && reason.trim().length > 0) {
      await this.transport.addComment(id, `▶ Unblocked: ${reason}`);
    }
    if (this.transport.removeLabel === undefined) {
      throw new BaronError(
        `Provider '${this.cfg.provider}' cannot remove a label, so the blocked flag cannot be ` +
          'cleared. Clear it in the provider.',
        'NOT_SUPPORTED',
      );
    }
    await this.transport.removeLabel(id, BLOCKED_LABEL);
    return this.get(id);
  }

  /**
   * The flag rides a label, so a provider without labels cannot carry it. Negotiated rather than
   * assumed — a silently-unblocked item is exactly the kind of gap invariant #5 forbids.
   */
  private requireBlockedFlag(): void {
    resolveCapabilityGap(
      this.manifest.issues.nativeLabels,
      'blockedFlag',
      this.cfg.provider,
      this.cfg.gapPolicy,
      this.logger,
    );
  }

  async classifyMove(id: string, role: WorkflowRole): Promise<RoleMoveResult> {
    const issue = await this.get(id);
    return {
      kind: classifyRoleMove(issue.role, role),
      to: role,
      ...(issue.role !== undefined ? { from: issue.role } : {}),
    };
  }

  async transition(id: string, role: WorkflowRole): Promise<Issue> {
    const target = this.resolver.toNative(role);

    const needsEmulatedState =
      !this.manifest.issues.arbitraryStates && role !== 'done' && role !== 'backlog';
    if (needsEmulatedState) {
      resolveGap('arbitraryStates', this.manifest, this.cfg.gapPolicy, this.logger);
    }

    const applied = await this.transport.applyTarget(id, target);
    // On a label-keyed provider the write only ADDS the new role's label; without clearing the
    // others an item ends up tagged in-progress AND in-review (and a stale label outlives a close).
    // Through the resolver, not past it: which key discriminates is the resolver's knowledge, and
    // this was the one place in the adapter that reached into the raw role map to ask.
    const keep = target[this.resolver.discriminatorKey];
    const stale = this.resolver
      .roleLabels()
      .filter((label) => label !== keep && applied.labels.includes(label));
    if (stale.length > 0 && this.transport.removeLabel !== undefined) {
      for (const label of stale) await this.transport.removeLabel(id, label);
      return this.toIssue({ ...applied, labels: applied.labels.filter((l) => !stale.includes(l)) });
    }
    return this.toIssue(applied);
  }

  /**
   * Make the emulated role labels agree with the state the provider itself reports.
   *
   * Role labels are Baron's OWN artifact — it writes them to express roles a provider's states
   * cannot. So when the provider changes an item behind Baron's back (a PR merging with
   * `Closes #N`), nobody clears the label Baron wrote, and it outlives the close. Since v0.29.1
   * the READ is right (a closed item reads `done`), but the label is still physically there,
   * showing up in the provider's UI and in every label filter.
   *
   * This is deliberately NOT a transition: it commands no role. It reads the role the provider's
   * own state already implies and removes the emulation that contradicts it. On a state-keyed
   * provider (Azure) there are no role labels, so it is a no-op — which is why landing a PR can
   * call it unconditionally without forcing a GitHub-shaped "merge means done" onto anyone else.
   */
  async reconcile(id: string): Promise<Issue> {
    const native = await this.transport.getIssue(id);
    const fromState = this.resolver.roleFromNativeState(native.discriminator);
    // The provider's state carries no role, so the labels are the only signal there is; removing
    // them would destroy information rather than correct it.
    if (fromState === undefined) return this.toIssue(native);

    const keep = this.resolver.toNative(fromState).label;
    const stale = this.resolver
      .roleLabels()
      .filter((label) => label !== keep && native.labels.includes(label));
    const missing = keep !== undefined && !native.labels.includes(keep) ? keep : undefined;
    if (stale.length === 0 && missing === undefined) return this.toIssue(native);

    if (stale.length > 0 && this.transport.removeLabel !== undefined) {
      for (const label of stale) await this.transport.removeLabel(id, label);
    }
    if (missing !== undefined) await this.transport.addLabel(id, missing);

    this.logger.info(
      `Reconciled '${id}' to role '${fromState}' from native state '${native.discriminator}'` +
        `${stale.length > 0 ? ` (cleared stale: ${stale.join(', ')})` : ''}` +
        `${missing !== undefined ? ` (added: ${missing})` : ''}`,
    );
    return this.toIssue({
      ...native,
      labels: [
        ...native.labels.filter((label) => !stale.includes(label)),
        ...(missing !== undefined ? [missing] : []),
      ],
    });
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

  async update(id: string, update: IssueUpdate): Promise<Issue> {
    if (update.title === undefined && update.body === undefined) {
      throw new BaronError(
        "Nothing to update: pass a 'title' and/or a 'body'.",
        'ISSUE_UPDATE_EMPTY',
      );
    }
    // The body's destination depends on the item's type (a bug's body is its repro steps), and only
    // the live item knows its type — so read it and resolve the role here. Skip the read when the
    // patch is title-only: the destination is then type-independent.
    let typeRole: WorkItemTypeRole | undefined;
    if (update.body !== undefined) {
      const current = await this.transport.getIssue(id);
      typeRole = this.reverseTypeRole(current.nativeType);
    }
    const native = await this.transport.updateIssue(id, { ...update, typeRole });
    return this.toIssue(native);
  }

  whoAmI(): Promise<string> {
    return this.transport.currentUser();
  }

  async ensureLabels(labels: readonly LabelSpec[]): Promise<void> {
    // Native-state providers have no ensureLabels transport method: nothing to provision.
    await this.transport.ensureLabels?.(labels);
  }

  async assign(id: string, assignee: string): Promise<Issue> {
    if (!this.manifest.issues.assignment) {
      resolveGap('assignment', this.manifest, this.cfg.gapPolicy, this.logger);
      // 'degrade' reaches here: the assignment is intentionally dropped (warned), return unchanged.
      return this.get(id);
    }
    return this.toIssue(await this.transport.assignIssue(id, assignee));
  }

  async iterations(): Promise<readonly Iteration[]> {
    if (!this.manifest.issues.sprints) {
      resolveGap('sprints', this.manifest, this.cfg.gapPolicy, this.logger);
      // A provider without sprints has none — 'degrade' returns empty (the gap was already warned).
      return [];
    }
    return this.transport.listIterations();
  }

  async currentIteration(): Promise<Iteration | undefined> {
    return (await this.iterations()).find((iteration) => iteration.current);
  }

  async setIteration(id: string, iteration: string): Promise<Issue> {
    if (!this.manifest.issues.sprints) {
      resolveGap('sprints', this.manifest, this.cfg.gapPolicy, this.logger);
      // 'degrade' reaches here: the move is intentionally dropped (warned), return unchanged.
      return this.get(id);
    }
    const path =
      iteration === ITERATION_CURRENT ? (await this.currentIteration())?.path : iteration;
    if (path === undefined) {
      throw new BaronError(
        'No active iteration to assign to — no sprint is current (set sprint dates in the provider).',
        'NO_CURRENT_ITERATION',
      );
    }
    return this.toIssue(await this.transport.setIteration(id, path));
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
    // A provider whose query cannot filter by type will IGNORE the one we hand it and return
    // everything, which reads as a successful filter and is the worst of both outcomes. Negotiate it
    // like any other missing capability rather than letting it pass silently (invariant #5).
    let postFilterTypeRole: WorkItemTypeRole | undefined;
    if (filter.typeRole !== undefined && !this.manifest.issues.typeFiltering) {
      const { behavior } = resolveGap(
        'typeFiltering',
        this.manifest,
        this.cfg.gapPolicy,
        this.logger,
      );
      if (behavior.kind === 'emulate') {
        if (behavior.strategy !== 'post-filter') {
          throw new BaronError(
            `Unknown emulation strategy '${behavior.strategy}' for 'typeFiltering' on provider ` +
              `'${this.cfg.provider}'. Only 'post-filter' is implemented.`,
            'GAP_STRATEGY',
          );
        }
        postFilterTypeRole = filter.typeRole;
      }
      // `degrade` falls through with no post-filter: the warning is already logged, and the caller
      // gets an honestly-unfiltered result rather than a silently-unfiltered one.
    }

    // Resolve the '@current' iteration sentinel to a concrete path. When nothing is current, a
    // "@current" filter can match nothing — return early rather than querying without the filter.
    let iterationPath = filter.iteration;
    if (iterationPath === ITERATION_CURRENT) {
      iterationPath = (await this.currentIteration())?.path;
      if (iterationPath === undefined) return [];
    }
    const query = {
      ...(filter.role !== undefined ? { target: this.resolver.toNative(filter.role) } : {}),
      ...(nativeType !== undefined ? { nativeType } : {}),
      ...(filter.assignee !== undefined ? { assignee: filter.assignee } : {}),
      ...(iterationPath !== undefined ? { iterationPath } : {}),
      // When the type filter is emulated, `limit` cannot be a transport hint: the transport would
      // return that many items of every type and the filter would then cut it below what was asked
      // for. It becomes a budget applied after filtering instead.
      ...(filter.limit !== undefined && postFilterTypeRole === undefined
        ? { limit: filter.limit }
        : {}),
    };
    const natives = await this.transport.queryIssues(query);
    const issues = natives.map((native) => this.toIssue(native));
    if (postFilterTypeRole === undefined) return issues;
    const matching = issues.filter((issue) => issue.typeRole === postFilterTypeRole);
    return filter.limit === undefined ? matching : matching.slice(0, filter.limit);
  }

  private toIssue(native: NativeIssue): Issue {
    const typeRole = this.resolveTypeRole(native);
    return {
      id: native.id,
      key: native.key,
      title: native.title,
      body: native.body,
      nativeType: native.nativeType,
      typeRole,
      role: this.resolveRole(native),
      // Read independently of the role, which is the entire point: a blocked item still reports the
      // role it is blocked IN.
      blocked: native.labels.includes(BLOCKED_LABEL),
      nativeState: native.discriminator,
      parentId: native.parentId,
      labels: native.labels,
      assignee: native.assignee,
      iteration: native.iteration,
      branchName: deriveBranchName({ id: native.id, title: native.title, typeRole }),
      url: native.url,
      provider: this.cfg.provider,
    };
  }

  /**
   * Read an item's role from what the provider actually reports.
   *
   * Role labels EMULATE the roles a provider's own states cannot express, so they are only the
   * truth while the provider's state is silent. When the native state resolves to a role, the
   * provider is speaking about the item first-hand and wins — otherwise an item closed by the
   * provider itself (a PR merging with `Closes #N`, a manual close) keeps reading `in_progress`
   * off the label Baron never got the chance to clear, because no `transition` ever ran.
   *
   * The mirror case: a label whose role pins a native state the item is NOT in is equally stale
   * (reopen a `done` item and the `done` label outlives the close). Reporting no role is honest
   * there; claiming the stale one is not.
   */
  private resolveRole(native: NativeIssue): WorkflowRole | undefined {
    const fromState =
      this.resolver.roleFromNativeState(native.discriminator) ??
      this.resolver.toRole(native.discriminator);
    if (fromState !== undefined) return fromState;
    const fromLabel = this.resolver.roleFromLabels(native.labels);
    if (fromLabel === undefined) return undefined;
    return this.resolver.toNative(fromLabel).state === undefined ? fromLabel : undefined;
  }

  /** True when several type roles share one native type, making the reverse lookup ambiguous. */
  private isAmbiguousNativeType(nativeType: string): boolean {
    return Object.values(this.cfg.typeMap).filter((name) => name === nativeType).length > 1;
  }

  /**
   * The item's type role. An explicit `type:<role>` label wins — it is exact, and it is what create
   * wrote on a flat provider. Otherwise fall back to reversing the native type (faithful on a
   * provider with real types; a best-effort tie-break on one without, e.g. items created before
   * the label existed).
   */
  private resolveTypeRole(native: NativeIssue): WorkItemTypeRole | undefined {
    for (const label of native.labels) {
      if (!label.startsWith(TYPE_ROLE_LABEL_PREFIX)) continue;
      const role = label.slice(TYPE_ROLE_LABEL_PREFIX.length);
      if (isWorkItemTypeRole(role)) return role;
    }
    return this.reverseTypeRole(native.nativeType);
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
