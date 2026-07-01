#!/usr/bin/env node
// Dependency-license hygiene gate (ARCHITECTURE decision #20). Redistributing a transitive
// copyleft/non-commercial/proprietary dependency would poison Baron's permissive (and any future
// commercial) distribution — so a denylisted license in the PRODUCTION dependency graph fails CI.
// Scope is `--prod`: only `dependencies` reach consumers of the published packages; devDependencies
// (biome, tsup, vitest, …) are never redistributed, so their licenses are out of scope here.
import { execSync } from 'node:child_process';

// Known-permissive SPDX ids we redistribute without review. Anything outside this set that is not
// outright denied is surfaced as a WARN (review it, then either add it here or waive it below).
const ALLOW = new Set([
  'MIT',
  'MIT-0',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSD',
  '0BSD',
  'ISC',
  'CC0-1.0',
  'Unlicense',
  'BlueOak-1.0.0',
  'Python-2.0',
  'Zlib',
  'WTFPL',
  'BSL-1.0', // Boost Software License — permissive (NOT the Business Source License, which is BUSL)
]);

// Hard-fail patterns: strong copyleft, source-available (non-OSS), non-commercial, and proprietary.
// `\bGPL` intentionally does NOT match `LGPL` (no word boundary before its `G`), so LGPL falls
// through to WARN rather than a hard fail — weak copyleft via npm is case-by-case, not auto-poison.
const DENY = [
  { label: 'AGPL', re: /\bAGPL/i },
  { label: 'GPL', re: /\bGPL/i },
  { label: 'SSPL', re: /\bSSPL/i },
  { label: 'Business Source (BUSL)', re: /\bBUSL|Business Source/i },
  { label: 'non-commercial (CC …-NC…)', re: /-NC(-|\b)|NonCommercial/i },
  { label: 'Commons Clause', re: /Commons[-\s]?Clause/i },
  { label: 'proprietary / no grant (UNLICENSED)', re: /^UNLICENSED$/i },
];

// Escape hatch for a verified false positive (e.g. a permissive OR-branch of a dual license).
// Keyed by package name; document WHY inline. Empty today — every prod dep is permissive.
const WAIVERS = new Map([
  // ['some-pkg', 'dual-licensed (MIT OR GPL-2.0); we choose MIT — reviewed 2026-07-01'],
]);

function readProdLicenses() {
  // pnpm emits a `{ [license]: PackageEntry[] }` object on stdout; stderr may carry progress noise.
  const raw = execSync('pnpm licenses list --prod --json', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

const byLicense = readProdLicenses();
const denied = [];
const warned = [];

for (const [license, entries] of Object.entries(byLicense)) {
  const names = (Array.isArray(entries) ? entries : []).map((e) => e?.name ?? '<unknown>');
  const hit = DENY.find((d) => d.re.test(license));
  if (hit) {
    const offenders = names.filter((n) => !WAIVERS.has(n));
    if (offenders.length > 0) denied.push({ license, label: hit.label, names: offenders });
  } else if (!ALLOW.has(license)) {
    warned.push({ license, names });
  }
}

const seen = Object.keys(byLicense).sort();
console.log(`Scanned production dependency licenses: ${seen.join(', ') || '(none)'}`);

if (warned.length > 0) {
  console.log('\n⚠️  Unrecognized licenses (review — allow in ALLOW or waive in WAIVERS):');
  for (const w of warned) console.log(`   ${w.license}: ${w.names.join(', ')}`);
}

if (denied.length > 0) {
  console.error('\n❌ Denied licenses in the production dependency graph:');
  for (const d of denied) console.error(`   [${d.label}] ${d.license}: ${d.names.join(', ')}`);
  console.error(
    '\nRedistributing these would poison the permissive/commercial distribution. Remove or replace ' +
      'the dependency, or (if a verified false positive) add a documented waiver in scripts/check-licenses.mjs.',
  );
  process.exit(1);
}

console.log('\n✅ No denied licenses in the production dependency graph.');
