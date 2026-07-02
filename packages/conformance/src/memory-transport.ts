import type {
  IssuesTransport,
  NativeComment,
  NativeCreateInput,
  NativeIssue,
  NativeQuery,
  NativeTarget,
} from '@lonca/baron-core';

interface Rec {
  id: string;
  key: string;
  title: string;
  body: string | undefined;
  nativeType: string;
  discriminator: string;
  parentId: string | undefined;
  labels: string[];
  assignee: string | undefined;
  url: string;
  links: Array<{ toId: string; type: string }>;
}

export interface MemoryTransportOptions {
  /** Which NativeTarget key carries the discriminator this provider reverses roles from. */
  readonly stateKey: string;
  /** The discriminator a freshly created issue carries (Azure 'New', GitHub 'open'). */
  readonly defaultDiscriminator: string;
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
    url: r.url,
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
        nativeType: input.nativeType,
        discriminator: opts.defaultDiscriminator,
        parentId: input.parentId,
        labels: [...input.labels],
        assignee: undefined,
        url: `mem://${id}`,
        links: [],
      };
      store.set(id, rec);
      return snapshot(rec);
    },

    async getIssue(id: string): Promise<NativeIssue> {
      return snapshot(must(id));
    },

    async applyTarget(id: string, target: NativeTarget): Promise<NativeIssue> {
      const rec = must(id);
      const discriminator = target[opts.stateKey];
      if (discriminator !== undefined) rec.discriminator = discriminator;
      const label = target.label;
      if (label !== undefined && !rec.labels.includes(label)) rec.labels.push(label);
      return snapshot(rec);
    },

    async addLabel(id: string, label: string): Promise<void> {
      const rec = must(id);
      if (!rec.labels.includes(label)) rec.labels.push(label);
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

    async assignIssue(id: string, assignee: string): Promise<NativeIssue> {
      const rec = must(id);
      rec.assignee = assignee;
      return snapshot(rec);
    },

    async queryIssues(query: NativeQuery): Promise<readonly NativeIssue[]> {
      const discriminator = query.target?.[opts.stateKey];
      const results: NativeIssue[] = [];
      for (const rec of store.values()) {
        if (discriminator !== undefined && rec.discriminator !== discriminator) continue;
        if (query.nativeType !== undefined && rec.nativeType !== query.nativeType) continue;
        results.push(snapshot(rec));
      }
      return query.limit !== undefined ? results.slice(0, query.limit) : results;
    },
  };
}
