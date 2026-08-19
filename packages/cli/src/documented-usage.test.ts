import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * How `--recipe` is written wherever a reader is told to type it.
 *
 * `<path>` is not a shorter way of saying the same thing: it denies that a built-in name works, and
 * sends a reader hunting for a YAML file that ships inside the package. The CLI printed that form
 * for the whole life of named recipes, and two shipped documents still did.
 */
const PLACEHOLDER = '<name-or-path>';

function markdownUnder(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) markdownUnder(full, found);
    else if (entry.name.endsWith('.md')) found.push(full);
  }
  return found;
}

describe('how the docs tell a reader to name a recipe', () => {
  it('spells the placeholder the same way everywhere it is written', () => {
    const files = [
      `${ROOT}README.md`,
      ...markdownUnder(`${ROOT}docs`),
      ...markdownUnder(`${ROOT}plugins`),
    ];
    expect(files.length, 'no markdown found — the layout moved').toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(/--recipe (<[^>]+>)/g)) {
        if (match[1] !== PLACEHOLDER) offenders.push(`${file.slice(ROOT.length)}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
