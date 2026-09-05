import type {
  IssuesTransport,
  NativeComment,
  NativeCreateInput,
  NativeIssue,
  NativeQuery,
  NativeTarget,
  NativeUpdateInput,
  TransitionField,
  TransitionFields,
} from '@lonca/baron-core';

interface Rec {
  id: string;
  key: string;
  title: string;
  body: string | undefined;
  nativeType: string;
  /** The abstract type role the adapter forwarded (bugs route their body to a native field). */
  typeRole: string;
  discriminator: string;
  parentId: string | undefined;
  labels: string[];
  assignee: string | undefined;
  iteration: string | undefined;
  url: string;
  links: Array<{ toId: string; type: string }>;
  /** Screen answers the last transition carried — what a Jira issue would show on its fields. */
  fields: Record<string, unknown>;
}

/** The fixed fake identity '@me' resolves to — shared by currentUser/assign/query so they cohere. */
const MEMORY_ME = 'me@example.com';

/** Two fixed iterations so the suite can exercise the sprint path; "Sprint 2" is current. */
const MEMORY_ITERATIONS = [
  { id: 'it-1', name: 'Sprint 1', path: 'Mem\\Sprint 1', current: false },
  { id: 'it-2', name: 'Sprint 2', path: 'Mem\\Sprint 2', current: true },
] as const;

export interface MemoryTransportOptions {
  /** Which NativeTarget key carries the discriminator this provider reverses roles from. */
  readonly stateKey: string;
  /** The discriminator a freshly created issue carries (Azure 'New', GitHub 'open'). */
  readonly defaultDiscriminator: string;
  /**
   * For a provider that cannot be told a work-item type: the type every created item reports back
   * instead, whatever the type map asked for (GitHub 'issue'). Leave unset for a provider that
   * stores the type it is given.
   *
   * This exists because echoing the requested type back is a fidelity the live GitHub transport
   * does not have, and modelling it made the suite prove a round-trip GitHub would fail — which is
   * exactly how a dropped type-role label reached a real repository.
   */
  readonly untypedNativeType?: string | undefined;
  /**
   * Set false for a provider whose query cannot filter by work-item type (GitHub's `listForRepo`
   * takes labels, state and assignee and nothing else). It then IGNORES the type in a query, exactly
   * as the real one does — which is what makes the suite able to see an unfiltered result being
   * handed back as if it were filtered.
   */
  readonly filtersByType?: boolean | undefined;
  /**
   * Set false to model a transport that implements `addLabel` but not `removeLabel` — the shape the
   * contract permits and the Azure adapter actually had, which made the blocked flag a one-way door
   * there. Implementing it here unconditionally is a third case of the suite proving a fidelity a
   * real adapter lacked.
   */
  readonly canRemoveLabels?: boolean | undefined;
  /**
   * The scope every item created here belongs to, for a provider whose states are owned by
   * something inside the workspace (a Linear team). Reported on every {@link NativeIssue}.
   */
  readonly scope?: string | undefined;
  /**
   * Discriminator values this scope owns. When set, `applyTarget` REFUSES anything else — which is
   * the fidelity that matters: Linear rejects one team's state id on another team's issue, so a
   * fake that accepted it would let a scope-blind resolver pass a suite the real provider fails.
   * That is the same trap transport fidelity (#59) was written for.
   */
  readonly ownedDiscriminators?: readonly string[] | undefined;
  /**
   * Which discriminators are reachable from each one, for a provider that gates transitions the way
   * Jira does — a workflow permits a move FROM a state, not to any state at will.
   *
   * When set the transport implements `availableTargets`; when absent it does not implement it at
   * all, which is the shape of every provider that gates nothing. Both halves matter: the suite has
   * to prove the gate refuses, and that a transport without one behaves exactly as before.
   */
  readonly reachableFrom?: Readonly<Record<string, readonly string[]>> | undefined;
  /**
   * The screen a move INTO each discriminator carries, for a provider whose transitions can demand
   * fields the way Jira's do. When set the transport implements `transitionFields`, and its
   * `applyTarget` REFUSES a move whose required fields are missing — the fidelity that matters: a
   * fake that wrote anyway would let a core that skipped the check pass a suite Jira fails.
   */
  readonly screenFor?: Readonly<Record<string, readonly TransitionField[]>> | undefined;
}

/**
 * In-memory stand-in for a provider transport. It interprets a {@link NativeTarget} exactly the
 * way the conformance contract needs: the value under `stateKey` becomes the discriminator that
 * the role resolver reads back. This lets the suite prove the translation/impedance layer with
 * zero network access; the live SDK transports are validated separately by gated smoke tests.
 */
export function createMemoryTransport(opts: MemoryTransportOptions): IssuesTransport {
  let seq = 0;
  let commentSeq = 0;
  const store = new Map<string, Rec>();
  const provisionedLabels = new Set<string>();

  const snapshot = (r: Rec): NativeIssue => ({
    id: r.id,
    key: r.key,
    title: r.title,
    body: r.body,
    nativeType: r.nativeType,
    discriminator: r.discriminator,
    parentId: r.parentId,
    labels: [...r.labels],
    assignee: r.assignee,
    iteration: r.iteration,
    url: r.url,
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
  });

  const must = (id: string): Rec => {
    const r = store.get(id);
    if (r === undefined) throw new Error(`memory transport: issue '${id}' not found`);
    return r;
  };

  return {
    async createIssue(input: NativeCreateInput): Promise<NativeIssue> {
      seq += 1;
      const id = `mem-${seq}`;
      const rec: Rec = {
        id,
        key: `#${seq}`,
        title: input.title,
        body: input.body,
        nativeType: opts.untypedNativeType ?? input.nativeType,
        typeRole: input.typeRole,
        discriminator: opts.defaultDiscriminator,
        parentId: input.parentId,
        labels: [...input.labels],
        assignee: undefined,
        iteration: undefined,
        url: `mem://${id}`,
        links: [],
        fields: {},
      };
      store.set(id, rec);
      return snapshot(rec);
    },

    async getIssue(id: string): Promise<NativeIssue> {
      return snapshot(must(id));
    },

    async applyTarget(
      id: string,
      target: NativeTarget,
      fields?: TransitionFields,
    ): Promise<NativeIssue> {
      const rec = must(id);
      const discriminator = target[opts.stateKey];
      if (
        discriminator !== undefined &&
        opts.ownedDiscriminators !== undefined &&
        !opts.ownedDiscriminators.includes(discriminator)
      ) {
        throw new Error(
          `memory transport: '${discriminator}' does not belong to scope '${opts.scope}' ` +
            `(it owns: ${opts.ownedDiscriminators.join(', ')})`,
        );
      }
      if (discriminator !== undefined) {
        // Jira rejects the POST outright when the screen's required fields are absent; so does this,
        // so the suite can tell a core that checked from one that got lucky.
        const screen = opts.screenFor?.[discriminator] ?? [];
        const unanswered = screen.filter((f) => f.required && fields?.[f.name] === undefined);
        if (unanswered.length > 0) {
          throw new Error(
            `memory transport: moving to '${discriminator}' requires ` +
              `${unanswered.map((f) => f.name).join(', ')}`,
          );
        }
        rec.discriminator = discriminator;
        rec.fields = { ...fields };
      }
      const label = target.label;
      if (label !== undefined && !rec.labels.includes(label)) rec.labels.push(label);
      return snapshot(rec);
    },

    ...(opts.reachableFrom !== undefined
      ? {
          async availableTargets(id: string): Promise<readonly NativeTarget[]> {
            const rec = must(id);
            const reachable = opts.reachableFrom?.[rec.discriminator] ?? [];
            return reachable.map((value) => ({ [opts.stateKey]: value }));
          },
        }
      : {}),

    ...(opts.screenFor !== undefined
      ? {
          async transitionFields(
            id: string,
            target: NativeTarget,
          ): Promise<readonly TransitionField[]> {
            must(id);
            const discriminator = target[opts.stateKey];
            return discriminator === undefined ? [] : (opts.screenFor?.[discriminator] ?? []);
          },
        }
      : {}),

    async addLabel(id: string, label: string): Promise<void> {
      const rec = must(id);
      if (!rec.labels.includes(label)) rec.labels.push(label);
    },

    ...(opts.canRemoveLabels === false
      ? {}
      : {
          async removeLabel(id: string, label: string): Promise<void> {
            const rec = must(id);
            rec.labels = rec.labels.filter((l) => l !== label);
          },
        }),

    async ensureLabels(labels): Promise<void> {
      // Idempotent provisioning: record each name once (a repeat is a no-op), mirroring a real
      // create-if-missing without a network.
      for (const label of labels) provisionedLabels.add(label.name);
    },

    async addComment(id: string, body: string): Promise<NativeComment> {
      must(id);
      commentSeq += 1;
      return { id: `mem-comment-${commentSeq}`, body, url: `mem://comment/${commentSeq}` };
    },

    async linkIssues(fromId: string, toId: string, nativeLinkType: string): Promise<void> {
      const rec = must(fromId);
      must(toId);
      rec.links.push({ toId, type: nativeLinkType });
    },

    async updateIssue(id: string, update: NativeUpdateInput): Promise<NativeIssue> {
      const rec = must(id);
      // A patch: only the keys present change. (One body field here, so typeRole needs no routing —
      // the live adapters use it to pick the type's native field.)
      if (update.title !== undefined) rec.title = update.title;
      if (update.body !== undefined) rec.body = update.body;
      return snapshot(rec);
    },

    currentUser(): Promise<string> {
      return Promise.resolve(MEMORY_ME);
    },

    async assignIssue(id: string, assignee: string): Promise<NativeIssue> {
      const rec = must(id);
      // '@me' resolves to the same fixed fake identity currentUser/query use, so a round-trip of
      // assign('@me') → get().assignee === currentUser() holds — the ownership check depends on it.
      rec.assignee = assignee === '@me' ? MEMORY_ME : assignee;
      return snapshot(rec);
    },

    async listIterations() {
      return MEMORY_ITERATIONS.map((it) => ({ ...it }));
    },

    async setIteration(id: string, iterationPath: string): Promise<NativeIssue> {
      const rec = must(id);
      rec.iteration = iterationPath;
      return snapshot(rec);
    },

    async queryIssues(query: NativeQuery): Promise<readonly NativeIssue[]> {
      // An OR across targets: the reference implementation handles the plural case because that is
      // what a scoped provider produces, and a conformance fake that only ever honoured the first
      // one would pass a suite the real thing fails.
      const discriminators = query.targets
        ?.map((target) => target[opts.stateKey])
        .filter((value): value is string => value !== undefined);
      const results: NativeIssue[] = [];
      for (const rec of store.values()) {
        if (
          discriminators !== undefined &&
          discriminators.length > 0 &&
          !discriminators.includes(rec.discriminator)
        ) {
          continue;
        }
        if (
          opts.filtersByType !== false &&
          query.nativeType !== undefined &&
          rec.nativeType !== query.nativeType
        ) {
          continue;
        }
        // '@me' resolves to a fixed fake identity so the suite can exercise the sentinel path.
        const wanted = query.assignee === '@me' ? MEMORY_ME : query.assignee;
        if (wanted !== undefined && rec.assignee !== wanted) continue;
        if (query.iterationPath !== undefined && rec.iteration !== query.iterationPath) continue;
        results.push(snapshot(rec));
      }
      return query.limit !== undefined ? results.slice(0, query.limit) : results;
    },
  };
}
