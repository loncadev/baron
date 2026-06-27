/**
 * The knowledge loop (decision #11): durable `learning` and `followup` records an agent accumulates
 * across runs. Records are normalized and provider-agnostic; where they are persisted is a pluggable
 * {@link KnowledgeStore} (local markdown by default).
 */

export const FOLLOWUP_STATUSES = ['open', 'done'] as const;
export type FollowupStatus = (typeof FOLLOWUP_STATUSES)[number];

export function isFollowupStatus(value: string): value is FollowupStatus {
  return (FOLLOWUP_STATUSES as readonly string[]).includes(value);
}

/** Input to `learning.append`. */
export interface LearningDraft {
  readonly title: string;
  readonly body: string;
  readonly tags?: readonly string[] | undefined;
}

/** A normalized learning record. */
export interface Learning {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
}

/** Filter for `learning.query` (fields AND-combined). */
export interface LearningQuery {
  readonly tag?: string | undefined;
  /** Case-insensitive substring match over title + body. */
  readonly text?: string | undefined;
  readonly limit?: number | undefined;
}

/** Input to `followup.append`. */
export interface FollowupDraft {
  readonly title: string;
  readonly body?: string | undefined;
  readonly tags?: readonly string[] | undefined;
}

/** A normalized follow-up record. */
export interface Followup {
  readonly id: string;
  readonly title: string;
  readonly body?: string | undefined;
  readonly tags: readonly string[];
  readonly status: FollowupStatus;
  readonly createdAt: string;
}

/** Filter for `followup.list` (fields AND-combined). */
export interface FollowupQuery {
  readonly status?: FollowupStatus | undefined;
  readonly tag?: string | undefined;
  readonly limit?: number | undefined;
}
