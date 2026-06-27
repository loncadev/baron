import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KnowledgeStore } from './store.js';
import { type Followup, type Learning, isFollowupStatus } from './types.js';

/**
 * The default `local-md` {@link KnowledgeStore} (decision #11): one human-readable markdown file per
 * record, with a small frontmatter block, under `<dir>/learnings` and `<dir>/followups`. Frontmatter
 * is flat `key: value` (hand-parsed, no YAML dependency); the body is the markdown after it. Records
 * are committable knowledge an agent and a human can both read and edit.
 */
export function createMarkdownKnowledgeStore(dir: string): KnowledgeStore {
  const learningsDir = join(dir, 'learnings');
  const followupsDir = join(dir, 'followups');

  return {
    async appendLearning(learning) {
      write(learningsDir, learning.id, serialize(frontmatter(learning), learning.body));
    },
    async readLearnings() {
      return readAll(learningsDir).map(({ fields, body }) => ({
        id: fields.id ?? '',
        title: fields.title ?? '',
        body,
        tags: parseTags(fields.tags),
        createdAt: fields.createdAt ?? '',
      }));
    },
    async appendFollowup(followup) {
      write(
        followupsDir,
        followup.id,
        serialize({ ...frontmatter(followup), status: followup.status }, followup.body ?? ''),
      );
    },
    async readFollowups() {
      return readAll(followupsDir).map(({ fields, body }): Followup => {
        const status = fields.status ?? '';
        return {
          id: fields.id ?? '',
          title: fields.title ?? '',
          ...(body.length > 0 ? { body } : {}),
          tags: parseTags(fields.tags),
          status: isFollowupStatus(status) ? status : 'open',
          createdAt: fields.createdAt ?? '',
        };
      });
    },
  };
}

function frontmatter(record: Learning | Followup): Record<string, string> {
  return {
    id: record.id,
    title: oneLine(record.title),
    tags: record.tags.map(oneLine).join(', '),
    createdAt: record.createdAt,
  };
}

/** Frontmatter values are single-line; collapse any newlines so the block stays parseable. */
function oneLine(value: string): string {
  return value.replace(/\r?\n/g, ' ');
}

function serialize(fields: Record<string, string>, body: string): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join('\n')}\n---\n${body}\n`;
}

function write(directory: string, id: string, content: string): void {
  mkdirSync(directory, { recursive: true });
  // Records are append-only and ids are unique; refuse to clobber so an id collision surfaces loudly
  // instead of silently overwriting durable knowledge ('wx' fails if the file already exists).
  writeFileSync(join(directory, `${id}.md`), content, { encoding: 'utf8', flag: 'wx' });
}

function readAll(directory: string): Array<{ fields: Record<string, string>; body: string }> {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.md'))
    .map((name) => parseEntry(readFileSync(join(directory, name), 'utf8')));
}

function parseEntry(raw: string): { fields: Record<string, string>; body: string } {
  // Normalize CRLF first: these files are human-editable, and a Windows editor save rewrites them
  // with \r\n — without this the frontmatter regex would miss and swallow every field into the body.
  const text = raw.replace(/\r\n/g, '\n');
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (match?.[1] === undefined) return { fields: {}, body: text.trimEnd() };
  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  // serialize() appends exactly one trailing newline after the body; strip just that to round-trip
  // a body's own trailing whitespace exactly.
  const body = match[2] ?? '';
  return { fields, body: body.endsWith('\n') ? body.slice(0, -1) : body };
}

function parseTags(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim().length === 0) return [];
  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}
