// Apply each workspace package's `publishConfig` in place, to a deployed tree.
//
// Workspace packages resolve to SOURCE in dev (`main: ./src/index.ts`) and to `dist` only once
// published — `publishConfig` is what flips them, and `pnpm publish` applies it for us. A container
// image is a private publish in all but name: `pnpm deploy` copies the packages exactly as they sit
// on disk, which means in dev mode, and the first `import '@lonca/baron-core'` then hands Node a
// TypeScript file. The failure mode is nasty precisely because it is late — the image builds clean
// and dies on start, which is what an indexer reads as a broken server.
//
// Walks the whole tree rather than the top-level `@lonca/*` links: pnpm keeps the real directories
// under `node_modules/.pnpm/<pkg>/node_modules/@lonca/<name>`, so transitively-linked packages (the
// adapters, reached through baron-providers) live one level deeper and were missed by a scope-only
// pass — visibly, as an ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING on the azure-devops adapter.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Baron's own packages: the only ones whose on-disk manifests are in dev mode here. */
const WORKSPACE_SCOPE = '@lonca/';

const root = process.argv[2];
if (root === undefined) {
  console.error('usage: apply-publish-config.mjs <deployed-dir>');
  process.exit(2);
}

/** Every package.json under `dir`, following pnpm's nested node_modules but never a package's own source. */
function* manifests(dir, depth = 0) {
  if (depth > 6) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === 'package.json') yield join(dir, entry.name);
    // Symlinks are pnpm's links into .pnpm; skipping them avoids visiting the same real
    // directory twice (and, in a broken store, avoids a cycle).
    if (entry.isDirectory() && entry.name !== 'src' && entry.name !== 'dist') {
      yield* manifests(join(dir, entry.name), depth + 1);
    }
  }
}

let applied = 0;
for (const path of manifests(root)) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    continue;
  }
  // Ours only. A third-party package in the tree arrived from npm, which means its own publish
  // already applied its publishConfig; re-applying it is a no-op at best and, for a dependency that
  // uses the field for something other than the dist flip, an edit to a package we do not own.
  if (!String(manifest.name ?? '').startsWith(WORKSPACE_SCOPE)) continue;
  if (manifest.publishConfig === undefined) continue;
  writeFileSync(path, `${JSON.stringify({ ...manifest, ...manifest.publishConfig }, null, 2)}\n`);
  applied++;
}

// Never silently: a run that transformed nothing means the layout changed under us, and the only
// symptom would otherwise be a container that starts fine today and dies on the next pnpm upgrade.
console.error(`publishConfig applied to ${applied} package(s) under ${root}`);
if (applied === 0) process.exit(1);
