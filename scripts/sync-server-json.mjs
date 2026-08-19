// Keep server.json and the package the registry actually installs saying the same thing.
//
// Two facts have to agree across the two files, and both have bitten us:
//
//   version — server.json carries it twice (top level and inside the npm package entry) and
//   RELEASING.md bumps the ten package.json files without mentioning this one, so it drifted a
//   whole release behind. server.json is what the official MCP Registry ingests, and that surface
//   weights recency, so a stale value advertises the wrong version where it costs ranking.
//
//   mcpName — the registry refuses to list a server whose npm package cannot be proven to belong to
//   the same publisher. For npm the proof is this field in the *published* package.json matching
//   server.json's name exactly. It is the kind of string nobody re-reads, and a mismatch is not a
//   warning: it is a rejected submission.
//
// Reads rather than takes arguments: one source of truth beats three copies that agree by hand.
// `--check` asserts instead of writing, so CI catches the drift rather than the registry does.
import { readFileSync, writeFileSync } from 'node:fs';

const check = process.argv.includes('--check');
const PKG_PATH = 'packages/mcp-server/package.json';

const pkgRaw = readFileSync(PKG_PATH, 'utf8');
const pkg = JSON.parse(pkgRaw);
const manifest = JSON.parse(readFileSync('server.json', 'utf8'));
let pkgDrifted = false;

const drift = [];
const reconcile = (label, actual, expected, apply) => {
  if (actual === expected) return;
  drift.push(`${label}: ${actual ?? '(unset)'} -> ${expected}`);
  if (!check) apply();
};

reconcile('server.json version', manifest.version, pkg.version, () => {
  manifest.version = pkg.version;
});
if (manifest.packages?.[0] !== undefined) {
  reconcile('server.json package version', manifest.packages[0].version, pkg.version, () => {
    manifest.packages[0].version = pkg.version;
  });
}
// The name flows the other way: server.json owns the registry identity, package.json proves it.
reconcile(`${PKG_PATH} mcpName`, pkg.mcpName, manifest.name, () => {
  pkgDrifted = true;
});

if (check) {
  if (drift.length > 0) {
    console.error(
      `server.json is out of sync:\n  ${drift.join('\n  ')}\nRun: pnpm sync:server-json`,
    );
    process.exit(1);
  }
  console.log(`server.json in sync (${manifest.name} @ ${pkg.version})`);
} else {
  // Each file is written only if it actually drifted, and package.json is edited surgically. Both
  // were re-serialized every time before: bumping a version rewrote the manifest that had not moved,
  // and JSON.stringify re-flowed `"files": ["dist"]` across three lines — so the documented release
  // step left the repository failing its own lint check.
  if (drift.some((entry) => entry.startsWith('server.json'))) {
    writeFileSync('server.json', `${JSON.stringify(manifest, null, 2)}\n`);
  }
  if (pkgDrifted) {
    const next = /"mcpName"\s*:\s*"[^"]*"/.test(pkgRaw)
      ? pkgRaw.replace(/("mcpName"\s*:\s*)"[^"]*"/, (_m, prefix) => `${prefix}"${manifest.name}"`)
      : pkgRaw.replace(
          /("name"\s*:\s*"[^"]*",)/,
          (_m, nameLine) => `${nameLine}\n  "mcpName": "${manifest.name}",`,
        );
    if (next === pkgRaw) {
      console.error(`could not place mcpName in ${PKG_PATH}`);
      process.exit(1);
    }
    writeFileSync(PKG_PATH, next);
  }
  console.log(
    drift.length > 0
      ? `synced:\n  ${drift.join('\n  ')}`
      : `server.json already in sync (${manifest.name} @ ${pkg.version})`,
  );
}
