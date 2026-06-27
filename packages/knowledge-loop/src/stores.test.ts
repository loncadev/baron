import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createMarkdownKnowledgeStore } from './markdown-store.js';
import { createMemoryKnowledgeStore } from './memory-store.js';
import { runKnowledgeStoreConformance } from './store-conformance.js';

runKnowledgeStoreConformance({ label: 'memory', build: createMemoryKnowledgeStore });

const tempRoots: string[] = [];
runKnowledgeStoreConformance({
  label: 'markdown',
  build: () => {
    const root = mkdtempSync(join(tmpdir(), 'baron-kl-'));
    tempRoots.push(root);
    return createMarkdownKnowledgeStore(root);
  },
});

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe('markdown store on disk', () => {
  it('persists learnings as readable per-record markdown files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'baron-kl-'));
    tempRoots.push(root);
    const store = createMarkdownKnowledgeStore(root);
    await store.appendLearning({
      id: 'abc',
      title: 'Use roles, not states',
      body: 'Recipes speak roles.',
      tags: ['design'],
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    // A fresh store over the same dir reads the persisted record back.
    const reopened = createMarkdownKnowledgeStore(root);
    const all = await reopened.readLearnings();
    expect(all).toHaveLength(1);
    expect(all[0]?.title).toBe('Use roles, not states');
  });

  it('still parses a record a human re-saved with CRLF line endings', async () => {
    const root = mkdtempSync(join(tmpdir(), 'baron-kl-'));
    tempRoots.push(root);
    const store = createMarkdownKnowledgeStore(root);
    await store.appendLearning({
      id: 'crlf',
      title: 'Edited on Windows',
      body: 'line one\nline two',
      tags: ['a', 'b'],
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    // Simulate a Windows editor rewriting the file with CRLF.
    const dir = join(root, 'learnings');
    const file = join(dir, readdirSync(dir)[0] as string);
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\n/g, '\r\n'), 'utf8');

    const reopened = createMarkdownKnowledgeStore(root);
    const learnings = await reopened.readLearnings();
    expect(learnings).toHaveLength(1);
    expect(learnings[0]?.title).toBe('Edited on Windows');
    expect(learnings[0]?.tags).toEqual(['a', 'b']);
    expect(learnings[0]?.body).toBe('line one\nline two');
  });
});
