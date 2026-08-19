import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

/** Every workspace package's published name, read from the packages that actually exist. */
function workspacePackageNames(): string[] {
  const names: string[] = [];
  for (const dir of ['packages', 'packages/adapters']) {
    for (const entry of readdirSync(`${REPO}${dir}`, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const manifest = JSON.parse(
          readFileSync(`${REPO}${dir}/${entry.name}/package.json`, 'utf8'),
        ) as { name?: string };
        if (typeof manifest.name === 'string') names.push(manifest.name);
      } catch {
        // Not a package directory; `packages/adapters` itself has no manifest.
      }
    }
  }
  return names;
}

describe('the open-core scope in NOTICE', () => {
  it('names every package in the workspace', () => {
    // NOTICE was corrected by hand once and broke again the moment an adapter was added — the third
    // time in one stretch of work that a list nothing tied to reality drifted, after the documented
    // tool names and the Dockerfile's enumerated packages. Those two were closed by tying them; this
    // one was not, and it is the one that came back. A licence notice that omits a package it covers
    // is the worst place for that, because being precise about scope is its entire job.
    const notice = readFileSync(`${REPO}NOTICE`, 'utf8');
    const names = workspacePackageNames();
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => !notice.includes(name))).toEqual([]);
  });
});
