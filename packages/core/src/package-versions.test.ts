import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Reaches out of the package because the agreement spans every package: one release, one version.
const PACKAGES = fileURLToPath(new URL('../../', import.meta.url));

function manifests(): Array<{ file: string; name: string; version: string }> {
  const found: Array<{ file: string; name: string; version: string }> = [];
  const read = (file: string) => {
    const parsed = JSON.parse(readFileSync(`${PACKAGES}${file}`, 'utf8'));
    found.push({ file, name: parsed.name, version: parsed.version });
  };
  for (const entry of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'adapters') {
      for (const adapter of readdirSync(`${PACKAGES}adapters`, { withFileTypes: true })) {
        if (adapter.isDirectory()) read(`adapters/${adapter.name}/package.json`);
      }
      continue;
    }
    read(`${entry.name}/package.json`);
  }
  return found;
}

describe('the version every package publishes under', () => {
  it('is the same one', () => {
    // Releases bump these by hand, and the failure a straggler causes is quiet: pnpm rewrites
    // `workspace:*` to whatever version a package carries, so one file left behind either collides
    // with an already-published version or ships a dependency pinned to the release before. Nothing
    // asks — which is why this does.
    const all = manifests();
    expect(all.length, 'no packages found — the layout moved').toBeGreaterThan(5);
    const versions = new Map<string, string[]>();
    for (const { name, version } of all) {
      versions.set(version, [...(versions.get(version) ?? []), name]);
    }
    expect(
      [...versions.entries()].map(([version, names]) => `${version}: ${names.join(', ')}`),
    ).toHaveLength(1);
  });
});
