import { BaronError } from '@lonca/baron-core';
import { describe, expect, it } from 'vitest';
import { KnowledgeLoop } from './loop.js';
import { createMemoryKnowledgeStore } from './memory-store.js';

/** A loop with deterministic ids and monotonically increasing timestamps. */
function deterministicLoop(): KnowledgeLoop {
  let idSeq = 0;
  let daySeq = 1;
  return new KnowledgeLoop(createMemoryKnowledgeStore(), {
    newId: () => `id-${idSeq++}`,
    now: () => `2026-01-${String(daySeq++).padStart(2, '0')}T00:00:00.000Z`,
  });
}

describe('KnowledgeLoop learnings', () => {
  it('normalizes and stores an appended learning', async () => {
    const loop = deterministicLoop();
    const learning = await loop.learningAppend({ title: 'T', body: 'B', tags: ['x'] });
    expect(learning).toEqual({
      id: 'id-0',
      title: 'T',
      body: 'B',
      tags: ['x'],
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(await loop.learningQuery()).toContainEqual(learning);
  });

  it('filters by tag and by case-insensitive text', async () => {
    const loop = deterministicLoop();
    await loop.learningAppend({ title: 'Roles beat states', body: 'abc', tags: ['design'] });
    await loop.learningAppend({ title: 'Other', body: 'unrelated', tags: ['ops'] });
    expect(await loop.learningQuery({ tag: 'design' })).toHaveLength(1);
    expect((await loop.learningQuery({ text: 'ROLES' }))[0]?.title).toBe('Roles beat states');
  });

  it('returns newest first and honors limit', async () => {
    const loop = deterministicLoop();
    await loop.learningAppend({ title: 'first', body: 'b' });
    await loop.learningAppend({ title: 'second', body: 'b' });
    const top = await loop.learningQuery({ limit: 1 });
    expect(top).toHaveLength(1);
    expect(top[0]?.title).toBe('second');
  });

  it('rejects an empty learning title', async () => {
    const loop = deterministicLoop();
    await expect(loop.learningAppend({ title: '  ', body: 'b' })).rejects.toBeInstanceOf(
      BaronError,
    );
  });

  it('rejects a tag containing a comma or newline (would corrupt the markdown store)', async () => {
    const loop = deterministicLoop();
    await expect(
      loop.learningAppend({ title: 'T', body: 'b', tags: ['a,b'] }),
    ).rejects.toBeInstanceOf(BaronError);
    await expect(
      loop.learningAppend({ title: 'T', body: 'b', tags: ['a\nb'] }),
    ).rejects.toBeInstanceOf(BaronError);
  });
});

describe('KnowledgeLoop follow-ups', () => {
  it('appends an open follow-up and lists it by status', async () => {
    const loop = deterministicLoop();
    const followup = await loop.followupAppend({ title: 'Wire live smoke', tags: ['debt'] });
    expect(followup.status).toBe('open');
    expect(followup.body).toBeUndefined();
    expect(await loop.followupList({ status: 'open' })).toHaveLength(1);
    expect(await loop.followupList({ status: 'done' })).toHaveLength(0);
    expect(await loop.followupList({ tag: 'debt' })).toHaveLength(1);
  });

  it('rejects an empty follow-up title', async () => {
    const loop = deterministicLoop();
    await expect(loop.followupAppend({ title: '' })).rejects.toBeInstanceOf(BaronError);
  });
});
