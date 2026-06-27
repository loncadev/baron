import { describe, expect, it } from 'vitest';
import type { KnowledgeStore } from './store.js';
import type { Followup, Learning } from './types.js';

export interface KnowledgeStoreConformanceTarget {
  readonly label: string;
  /** A fresh, empty store per call. */
  build(): KnowledgeStore;
}

const learning = (id: string, day: string): Learning => ({
  id,
  title: `Learning ${id}`,
  body: `Body of ${id}`,
  tags: ['alpha', 'beta'],
  createdAt: `2026-01-${day}T00:00:00.000Z`,
});

/**
 * The contract every {@link KnowledgeStore} must satisfy: append-then-read round-trips records
 * exactly (including a follow-up with no body and an empty tag set) and accumulates across appends.
 * Filtering is the loop's job, not the store's, so it is not exercised here.
 */
export function runKnowledgeStoreConformance(target: KnowledgeStoreConformanceTarget): void {
  describe(`knowledge store conformance: ${target.label}`, () => {
    it('round-trips a learning exactly', async () => {
      const store = target.build();
      const entry = learning('l1', '01');
      await store.appendLearning(entry);
      expect(await store.readLearnings()).toContainEqual(entry);
    });

    it('accumulates learnings across appends', async () => {
      const store = target.build();
      await store.appendLearning(learning('l1', '01'));
      await store.appendLearning(learning('l2', '02'));
      expect(await store.readLearnings()).toHaveLength(2);
    });

    it('round-trips follow-ups with and without a body, and an empty tag set', async () => {
      const store = target.build();
      const withBody: Followup = {
        id: 'f1',
        title: 'Has body',
        body: 'do the thing',
        tags: ['x'],
        status: 'open',
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      const withoutBody: Followup = {
        id: 'f2',
        title: 'No body',
        tags: [],
        status: 'done',
        createdAt: '2026-01-02T00:00:00.000Z',
      };
      await store.appendFollowup(withBody);
      await store.appendFollowup(withoutBody);
      const all = await store.readFollowups();
      expect(all).toContainEqual(withBody);
      expect(all).toContainEqual(withoutBody);
    });

    it('returns empty arrays for a fresh store', async () => {
      const store = target.build();
      expect(await store.readLearnings()).toEqual([]);
      expect(await store.readFollowups()).toEqual([]);
    });
  });
}
