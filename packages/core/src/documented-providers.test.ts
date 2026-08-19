import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Reaches out of the package on purpose: the agreement being protected spans it. What ships lives in
// packages/adapters, and what a reader is told ships lives in the README — nothing tied the two, so
// the table drifted the moment an adapter landed and no test could have noticed.
const ADAPTERS_DIR = fileURLToPath(new URL('../../adapters/', import.meta.url));
const README = fileURLToPath(new URL('../../../README.md', import.meta.url));
const PROVIDER_DOC = fileURLToPath(new URL('../../../docs/providers.md', import.meta.url));

/** The ids the adapters export — the only honest answer to what Baron supports. */
function shippedProviderIds(): string[] {
  const ids: string[] = [];
  for (const entry of readdirSync(ADAPTERS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = readFileSync(`${ADAPTERS_DIR}${entry.name}/src/provider.ts`, 'utf8');
    const match = source.match(/_PROVIDER\s*=\s*'([a-z-]+)'/);
    expect(match, `adapter '${entry.name}' exports no provider id`).not.toBeNull();
    ids.push((match as RegExpMatchArray)[1] as string);
  }
  return ids;
}

/** `azure-devops` and "Azure DevOps" are one claim written for two different readers. */
const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z]/g, '');

/**
 * Sentences that promise something is still to come.
 *
 * Deliberately narrow. Scanning whole paragraphs for the word "roadmap" also flagged a passage that
 * names GitHub and links to ROADMAP.md for an unrelated reason, and a guard that cries wolf is one
 * somebody eventually deletes. The cost of the narrowness is that a reworded promise ("X is
 * planned") slips past; the table check above is the load-bearing one.
 */
const roadmapClaims = (body: string): string[] =>
  body
    // Paragraph first, then sentence. Collapsing the whole file to one line instead swept the table
    // above the promise into the same "sentence" — a markdown row carries no full stop to end one.
    .split(/\n\s*\n/)
    .flatMap((paragraph) => paragraph.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/))
    .filter((sentence) => /on the \[?roadmap/i.test(sentence));

describe('what the documentation says Baron supports', () => {
  it("lists every shipped adapter in the README's provider table", () => {
    const rows = readFileSync(README, 'utf8')
      .split('\n')
      .filter((line) => /^\|\s*\*\*/.test(line));
    expect(rows.length, 'no provider table rows found — the table shape changed').toBeGreaterThan(
      0,
    );
    for (const id of shippedProviderIds()) {
      expect(
        rows.some((row) => normalize(row).includes(normalize(id))),
        `the README's provider table does not list '${id}', which ships`,
      ).toBe(true);
    }
  });

  it('does not call a shipped provider a roadmap item', () => {
    // Worse than an incomplete table: the table merely omitted Linear, while the sentence beneath it
    // actively told a reader Linear was not supported and that the name described intent, not
    // support. A reader who believed it went looking for another tool.
    const claims = roadmapClaims(readFileSync(README, 'utf8'));
    for (const id of shippedProviderIds()) {
      for (const claim of claims) {
        expect(
          normalize(claim).includes(normalize(id)),
          `the README calls '${id}' a roadmap item, but it ships: ${claim.slice(0, 90)}`,
        ).toBe(false);
      }
    }
  });

  it('gives every shipped adapter a column in the ports × providers table', () => {
    const header = readFileSync(PROVIDER_DOC, 'utf8')
      .split('\n')
      .find((line) => line.startsWith('| Port '));
    expect(header, 'the ports × providers table has no header row').toBeDefined();
    for (const id of shippedProviderIds()) {
      expect(
        normalize(header as string).includes(normalize(id)),
        `docs/providers.md has no column for '${id}'`,
      ).toBe(true);
    }
  });
});
