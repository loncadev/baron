import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from './consolidated.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Directories whose markdown is deliberately not held to the current tool surface.
 *
 * `dogfood/` is gitignored working notes and is not present in CI at all, so walking it would make
 * this test fail on a maintainer's machine and pass in CI — the worst possible arrangement.
 * `archive/` is a record of what a session actually saw; rewriting history to match today's names
 * would destroy the only thing it is for.
 */
const SKIP = new Set(['node_modules', '.git', 'dist', 'dogfood', 'archive']);

function markdownFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(path, found);
    else if (entry.name.endsWith('.md')) found.push(path);
  }
  return found;
}

describe('tool names in committed documentation', () => {
  it('all resolve to a tool the server publishes', () => {
    // The verb consolidation renamed every write tool, and fifteen dead names survived across a
    // dozen documents — including the two walkthroughs whose "did it install correctly?" step named
    // tools the server has never published, so the check meant to confirm a working install was
    // itself the broken part. Prose has no compiler; this is the nearest thing.
    const published = new Set<string>(Object.values(TOOL_NAMES));
    expect(published.size).toBeGreaterThan(0);

    const stale: string[] = [];
    const files = markdownFiles(REPO);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      for (const [name] of readFileSync(file, 'utf8').matchAll(/\bbaron_[a-z_]+/g)) {
        // `baron_issue_*` in prose extracts as a trailing underscore — a family, not a tool.
        if (name.endsWith('_') || published.has(name)) continue;
        stale.push(`${file.slice(REPO.length)}: ${name}`);
      }
    }
    expect([...new Set(stale)]).toEqual([]);
  });
});
