import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TransportHooks } from './index.js';
import { credentialsPath } from './paths.js';

/**
 * Apply a patch of `KEY=VALUE` entries to a credentials file's text, in place.
 *
 * A key already present is replaced on its own line; a new one is appended. Everything else —
 * comments, blank lines, the order a person put things in — is left exactly as it was, because
 * this file is the one a person edits by hand when something goes wrong, and a rewrite that
 * reorders it or drops their notes makes the next edit harder.
 */
export function upsertCredentials(text: string, patch: Readonly<Record<string, string>>): string {
  const pending = new Map(Object.entries(patch));
  const lines = text.length === 0 ? [] : text.split(/\r?\n/);
  const out = lines.map((line) => {
    const eq = line.indexOf('=');
    if (line.trimStart().startsWith('#') || eq === -1) return line;
    const key = line.slice(0, eq).trim();
    const value = pending.get(key);
    if (value === undefined) return line;
    pending.delete(key);
    return `${key}=${value}`;
  });
  // A trailing newline is the convention; make sure appended keys land on their own lines.
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  for (const [key, value] of pending) out.push(`${key}=${value}`);
  return `${out.join('\n')}\n`;
}

/**
 * The hook a live installation hands its transports: rotated tokens go back into
 * `<root>/.baron/credentials`, the gitignored file `baron init` wrote them to. Without it a
 * browser sign-in whose refresh token rotates on every use is good for exactly one process.
 */
export function createCredentialsFileHooks(root: string): TransportHooks {
  const path = credentialsPath(root);
  return {
    persistCredentials(patch) {
      let current = '';
      try {
        current = readFileSync(path, 'utf8');
      } catch {
        // No file yet (credentials came from the environment): one is created holding the patch.
        mkdirSync(dirname(path), { recursive: true });
      }
      writeFileSync(path, upsertCredentials(current, patch), 'utf8');
    },
  };
}
