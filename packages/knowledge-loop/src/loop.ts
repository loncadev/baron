import { randomUUID } from 'node:crypto';
import { BaronError } from '@lonca/baron-core';
import { filterFollowups, filterLearnings } from './filter.js';
import type { KnowledgeStore } from './store.js';
import type {
  Followup,
  FollowupDraft,
  FollowupQuery,
  Learning,
  LearningDraft,
  LearningQuery,
} from './types.js';

const ARGS = 'KNOWLEDGE_ARGS';

/**
 * Default id: a sortable time prefix + a random UUID. The random suffix keeps ids unique across
 * concurrent processes sharing the committed `.baron/knowledge` dir (a counter alone resets per
 * process and would collide).
 */
function defaultNewId(): string {
  return `${Date.now().toString(36)}-${randomUUID()}`;
}

/** Tags become a comma-joined single line in the markdown store; reject values that would corrupt it. */
function assertTags(tags: readonly string[] | undefined): void {
  for (const tag of tags ?? []) {
    if (tag.includes(',') || /[\r\n]/.test(tag)) {
      throw new BaronError(`tag '${tag}' must not contain a comma or a newline.`, ARGS);
    }
  }
}

export interface KnowledgeLoopOptions {
  /** ISO-8601 timestamp source; injectable for deterministic tests. */
  readonly now?: () => string;
  /** Record id source; injectable for deterministic tests. */
  readonly newId?: () => string;
}

/**
 * The `loop` primitives over a pluggable {@link KnowledgeStore}: append/query learnings and
 * append/list follow-ups. The loop normalizes records (id, tags, timestamp) and owns the filtering;
 * the store only persists and reads back. Workflow opinion (when to capture a learning) lives in
 * recipes, not here.
 */
export class KnowledgeLoop {
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(
    private readonly store: KnowledgeStore,
    options: KnowledgeLoopOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? defaultNewId;
  }

  async learningAppend(draft: LearningDraft): Promise<Learning> {
    if (draft.title.trim().length === 0) {
      throw new BaronError('learning requires a non-empty title.', ARGS);
    }
    assertTags(draft.tags);
    const learning: Learning = {
      id: this.newId(),
      title: draft.title,
      body: draft.body,
      tags: [...(draft.tags ?? [])],
      createdAt: this.now(),
    };
    await this.store.appendLearning(learning);
    return learning;
  }

  async learningQuery(query: LearningQuery = {}): Promise<readonly Learning[]> {
    return filterLearnings(await this.store.readLearnings(), query);
  }

  async followupAppend(draft: FollowupDraft): Promise<Followup> {
    if (draft.title.trim().length === 0) {
      throw new BaronError('followup requires a non-empty title.', ARGS);
    }
    assertTags(draft.tags);
    const followup: Followup = {
      id: this.newId(),
      title: draft.title,
      ...(draft.body !== undefined ? { body: draft.body } : {}),
      tags: [...(draft.tags ?? [])],
      status: 'open',
      createdAt: this.now(),
    };
    await this.store.appendFollowup(followup);
    return followup;
  }

  async followupList(query: FollowupQuery = {}): Promise<readonly Followup[]> {
    return filterFollowups(await this.store.readFollowups(), query);
  }
}
