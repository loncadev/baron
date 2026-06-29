import type { Env } from './index.js';

/**
 * Parse a `.baron/credentials` file (dotenv-style `KEY=VALUE` lines; `#` comments and blanks
 * ignored; surrounding quotes stripped). This file is gitignored and holds secrets — the committed
 * `policy.json` never does.
 */
export function parseCredentials(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key.length > 0) out[key] = value;
  }
  return out;
}

/**
 * Overlay a `.baron/credentials` file onto the process environment. A real environment variable
 * wins over the file (so CI secrets override a local file); the file fills the gaps. Returns the
 * base env unchanged when no file is present.
 */
export function mergeCredentials(baseEnv: Env, fileText: string | undefined): Env {
  if (fileText === undefined) return baseEnv;
  return { ...parseCredentials(fileText), ...baseEnv };
}
