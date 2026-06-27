import type { Followup, FollowupQuery, Learning, LearningQuery } from './types.js';

/**
 * Newest-first by ISO-8601 createdAt (lexicographic order matches chronological for ISO strings),
 * with id as a deterministic tiebreaker so records sharing a timestamp order consistently across
 * stores (the default id is time-prefixed, so id-desc aligns with newest-first).
 */
function byNewest(
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

export function filterLearnings(all: readonly Learning[], query: LearningQuery): Learning[] {
  let result = [...all];
  if (query.tag !== undefined) {
    result = result.filter((learning) => learning.tags.includes(query.tag as string));
  }
  if (query.text !== undefined) {
    const needle = query.text.toLowerCase();
    result = result.filter((learning) =>
      `${learning.title}\n${learning.body}`.toLowerCase().includes(needle),
    );
  }
  result.sort(byNewest);
  return query.limit !== undefined ? result.slice(0, query.limit) : result;
}

export function filterFollowups(all: readonly Followup[], query: FollowupQuery): Followup[] {
  let result = [...all];
  if (query.status !== undefined) {
    result = result.filter((followup) => followup.status === query.status);
  }
  if (query.tag !== undefined) {
    result = result.filter((followup) => followup.tags.includes(query.tag as string));
  }
  result.sort(byNewest);
  return query.limit !== undefined ? result.slice(0, query.limit) : result;
}
