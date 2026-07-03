import { readFileSync } from 'node:fs';

/**
 * The server's own package identity, read from the package.json that ships in the tarball. Works
 * from both `src/` (dev, tsx) and `dist/` (published build) — both sit one level below the package
 * root. Falling back to 0.0.0 keeps a broken read from ever crashing server startup.
 */
function readOwnPackage(): { name: string; version: string } {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw) as { name?: string; version?: string };
    return { name: pkg.name ?? 'baron-mcp-server', version: pkg.version ?? '0.0.0' };
  } catch {
    return { name: 'baron-mcp-server', version: '0.0.0' };
  }
}

export const OWN_PACKAGE = readOwnPackage();
