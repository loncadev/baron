import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BaronError } from '@lonca/baron-core';
import type { Recipe } from './recipe.js';

/**
 * The run journal: what makes a recipe that failed halfway safe to run again.
 *
 * `ship` and `task-finish` mutate several providers in sequence. A failure in the middle leaves the
 * world half-changed, and a plain re-run repeats the steps that already succeeded — the concrete
 * case is a second pull request. So every run appends one line per event to
 * `.baron/runs/<runId>.jsonl`: the inputs it started with, each answer, and each `do` step with an
 * idempotency key and the result it bound. Resuming replays the completed steps from the journal
 * instead of executing them, and carries on from the first one that has no entry.
 *
 * Pure append. A journal is never rewritten, so a crash while writing loses at most the last line.
 */

/** Where a project's journals live, relative to its root. Gitignored: it holds a run's answers. */
export const RUNS_DIR_REL = '.baron/runs';
export const RUN_JOURNAL_EXT = '.jsonl';

export const RUN_NOT_FOUND = 'RUN_NOT_FOUND';
export const RUN_RECIPE_CHANGED = 'RUN_RECIPE_CHANGED';
export const RUN_JOURNAL_CORRUPT = 'RUN_JOURNAL_CORRUPT';

export type JournalEntry =
  | {
      readonly kind: 'start';
      readonly at: string;
      readonly recipe: string;
      /**
       * How the harness that started the run referred to the recipe — a path, for the CLI — so it
       * can load the same one again. Absent when the name is the whole reference.
       */
      readonly source?: string;
      /** {@link recipeFingerprint} of the recipe as parsed, so a changed recipe refuses to resume. */
      readonly fingerprint: string;
      readonly inputs: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'resume'; readonly at: string }
  | { readonly kind: 'ask'; readonly at: string; readonly as: string; readonly value: unknown }
  | {
      readonly kind: 'do';
      readonly at: string;
      /** Where in the recipe: top-level index, with for_each iterations as `3[1]/0`. */
      readonly path: string;
      readonly op: string;
      /** {@link stepKey}: the same step with the same parameters in the same run has the same key. */
      readonly key: string;
      readonly as?: string;
      readonly result?: unknown;
    }
  | { readonly kind: 'note'; readonly at: string; readonly text: string }
  | {
      readonly kind: 'error';
      readonly at: string;
      readonly path?: string;
      readonly op?: string;
      readonly code?: string;
      readonly message: string;
    }
  | { readonly kind: 'end'; readonly at: string; readonly replayed: number };

export interface RunJournalStore {
  append(runId: string, entry: JournalEntry): void;
  /** Every entry of a run in order, or undefined when no such run was ever started. */
  read(runId: string): readonly JournalEntry[] | undefined;
}

/** Short, sortable, safe in a file name: a time prefix (base 36) and eight random hex digits. */
export function newRunId(now: number = Date.now()): string {
  return `${now.toString(36)}-${randomUUID().slice(0, 8)}`;
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) {
    throw new BaronError(`'${runId}' is not a run id.`, RUN_NOT_FOUND);
  }
}

/** JSON with object keys sorted at every level, so equal parameters always serialize equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      sorted[k] = (v as Record<string, unknown>)[k];
    }
    return sorted;
  });
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Identifies the recipe's instructions, not its file: whitespace and comments do not count. */
export function recipeFingerprint(recipe: Recipe): string {
  return sha256(canonicalJson(recipe));
}

/**
 * The idempotency key of one `do` step in one run: the run, the step's position, its op and its
 * fully interpolated parameters. A resumed run recomputes it from the restored context, so a step
 * whose parameters would now differ (a re-answered ask, an upstream result that changed) gets a new
 * key and runs again rather than reusing a result produced under other conditions.
 */
export function stepKey(runId: string, path: string, op: string, params: unknown): string {
  return sha256(`${runId}\n${path}\n${op}\n${canonicalJson(params ?? {})}`);
}

/** The path of a journal file. */
export function runJournalPath(root: string, runId: string): string {
  assertRunId(runId);
  return `${root}/${RUNS_DIR_REL}/${runId}${RUN_JOURNAL_EXT}`;
}

/** The two file operations a journal needs, so a harness with its own file system can supply them. */
export interface RunJournalFiles {
  read(path: string): string | undefined;
  append(path: string, text: string): void;
}

const nodeFiles: RunJournalFiles = {
  read(path) {
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  },
  append(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, text, 'utf8');
  },
};

function parseJournal(runId: string, text: string): JournalEntry[] {
  const entries: JournalEntry[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line) as JournalEntry);
    } catch {
      throw new BaronError(
        `Journal for run '${runId}' has an unreadable line ${index + 1}; it cannot be resumed. Start a new run.`,
        RUN_JOURNAL_CORRUPT,
      );
    }
  }
  return entries;
}

/** Journals under `<root>/.baron/runs/`, one file per run. */
export function createFileRunJournal(
  root: string,
  files: RunJournalFiles = nodeFiles,
): RunJournalStore {
  return {
    append(runId, entry) {
      files.append(runJournalPath(root, runId), `${JSON.stringify(entry)}\n`);
    },
    read(runId) {
      const text = files.read(runJournalPath(root, runId));
      return text === undefined ? undefined : parseJournal(runId, text);
    },
  };
}

/** An in-memory journal, for tests and for a harness that keeps its own store. */
export function createMemoryRunJournal(): RunJournalStore & {
  readonly runs: ReadonlyMap<string, readonly JournalEntry[]>;
} {
  const runs = new Map<string, JournalEntry[]>();
  return {
    runs,
    append(runId, entry) {
      assertRunId(runId);
      const list = runs.get(runId) ?? [];
      list.push(entry);
      runs.set(runId, list);
    },
    read(runId) {
      assertRunId(runId);
      return runs.get(runId);
    },
  };
}
