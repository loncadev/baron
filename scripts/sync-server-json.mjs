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

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
const manifest = JSON.parse(readFileSync('server.json', 'utf8'));

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
  pkg.mcpName = manifest.name;
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
  if (drift.length > 0) {
    writeFileSync('server.json', `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  console.log(
    drift.length > 0
      ? `synced:\n  ${drift.join('\n  ')}`
      : `server.json already in sync (${manifest.name} @ ${pkg.version})`,
  );
}
