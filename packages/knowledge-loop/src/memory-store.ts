import type { KnowledgeStore } from './store.js';
import type { Followup, Learning } from './types.js';

/**
 * In-memory {@link KnowledgeStore}. Deterministic and network-free — the reference the conformance
 * suite runs against and a fine default for tests and ephemeral runs.
 */
export function createMemoryKnowledgeStore(): KnowledgeStore {
  const learnings: Learning[] = [];
  const followups: Followup[] = [];
  return {
    async appendLearning(learning) {
      learnings.push(learning);
    },
    async readLearnings() {
      return [...learnings];
    },
    async appendFollowup(followup) {
      followups.push(followup);
    },
    async readFollowups() {
      return [...followups];
    },
  };
}
