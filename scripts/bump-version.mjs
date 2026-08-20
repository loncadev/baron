#!/usr/bin/env node
// Set every workspace package to one version.
//
// RELEASING used to say "bump the ten package.json versions first", which is the hand-maintained
// list this repository has spent its time removing everywhere else. The failure it invites is quiet:
// pnpm rewrites `workspace:*` to whatever version a package carries, so one file left behind either
// collides with an already-published version or ships a dependency pinned to the previous release,
// and nothing asks. The count is not written down here — the packages on disk are the list.
//
//   node scripts/bump-version.mjs 0.34.0
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Every workspace package.json — `packages/*` plus the adapters one level deeper. */
function packageFiles() {
  const found = [];
  for (const entry of readdirSync(`${ROOT}packages`, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'adapters') {
      for (const adapter of readdirSync(`${ROOT}packages/adapters`, { withFileTypes: true })) {
        if (adapter.isDirectory()) found.push(`packages/adapters/${adapter.name}/package.json`);
      }
      continue;
    }
    found.push(`packages/${entry.name}/package.json`);
  }
  return found.sort();
}

const version = process.argv[2];
if (version === undefined) {
  console.error('usage: node scripts/bump-version.mjs <version>');
  process.exit(2);
}
// Guarded because the argument reaches ten files and a typo is only visible at publish time.
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`'${version}' is not a semver version.`);
  process.exit(2);
}

for (const file of packageFiles()) {
  const path = `${ROOT}${file}`;
  const raw = readFileSync(path, 'utf8');
  const manifest = JSON.parse(raw);
  if (manifest.version === version) {
    console.log(`  ${manifest.name} already ${version}`);
    continue;
  }
  // Rewritten in place rather than re-serialized: JSON.stringify would reformat the whole file and
  // bury the one line that changed under a diff nobody can review.
  const next = raw.replace(
    /("version"\s*:\s*)"[^"]+"/,
    (_match, prefix) => `${prefix}"${version}"`,
  );
  if (next === raw) {
    console.error(`could not find a version field in ${file}`);
    process.exit(1);
  }
  writeFileSync(path, next, 'utf8');
  console.log(`  ${manifest.name} ${manifest.version} -> ${version}`);
}

// The plugin declares the same version to the server it launches, so a frozen plugin can be told
// apart from the rolling `@latest` server beside it. Bumped here because it is the same release, and
// a test holds the two equal — a plugin claiming a version it is not is worse than claiming none.
const PLUGIN_MANIFEST = 'plugins/claude-code/.claude-plugin/plugin.json';
const manifestRaw = readFileSync(`${ROOT}${PLUGIN_MANIFEST}`, 'utf8');
const bumpedManifest = manifestRaw.replace(
  /("BARON_PLUGIN_VERSION"\s*:\s*)"[^"]*"/,
  (_match, prefix) => `${prefix}"${version}"`,
);
if (bumpedManifest === manifestRaw && !manifestRaw.includes(`"${version}"`)) {
  console.error(`could not find BARON_PLUGIN_VERSION in ${PLUGIN_MANIFEST}`);
  process.exit(1);
}
writeFileSync(`${ROOT}${PLUGIN_MANIFEST}`, bumpedManifest, 'utf8');
console.log(`  ${PLUGIN_MANIFEST} -> ${version}`);

console.log('\nNow run: pnpm sync:server-json && pnpm install && pnpm build && pnpm test');
