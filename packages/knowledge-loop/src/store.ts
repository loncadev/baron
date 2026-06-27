import type { Followup, Learning } from './types.js';

/**
 * The pluggable persistence surface for the knowledge loop. Implementations only append and read
 * back the full set; filtering lives once in {@link KnowledgeLoop} (so every store filters
 * identically). Separating this — like the issues/scm transports — keeps the conformance suite
 * network-free and lets an install swap the backing store (local markdown by default) without
 * touching recipes.
 */
export interface KnowledgeStore {
  appendLearning(learning: Learning): Promise<void>;
  readLearnings(): Promise<readonly Learning[]>;
  appendFollowup(followup: Followup): Promise<void>;
  readFollowups(): Promise<readonly Followup[]>;
}
