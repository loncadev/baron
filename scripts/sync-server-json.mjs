// Keep server.json's version in step with the package the registry actually installs.
//
// It carries the version twice — top level and inside the npm package entry — and RELEASING.md
// bumps the ten package.json files without mentioning this one, so it drifted a whole release
// behind. server.json is what the official MCP Registry ingests, and that surface weights recency,
// so a stale value there advertises the wrong version on the one listing where it costs ranking.
//
// Reads rather than takes an argument: one source of truth beats three copies that agree by hand.
import { readFileSync, writeFileSync } from 'node:fs';

const version = JSON.parse(readFileSync('packages/mcp-server/package.json', 'utf8')).version;
const manifest = JSON.parse(readFileSync('server.json', 'utf8'));

const before = [manifest.version, manifest.packages?.[0]?.version];
manifest.version = version;
if (manifest.packages?.[0] !== undefined) manifest.packages[0].version = version;

writeFileSync('server.json', `${JSON.stringify(manifest, null, 2)}\n`);

const changed = before.some((v) => v !== version);
console.log(
  changed
    ? `server.json: ${before.join(' / ')} -> ${version}`
    : `server.json already at ${version}`,
);
