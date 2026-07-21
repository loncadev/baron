import { BARON_DIR } from '@lonca/baron-providers';
import type { RecipeAsker } from '@lonca/baron-recipes';
import type { FileSystem, Prompter } from './ports.js';

/** In-memory {@link FileSystem} keyed by exact path; directories are not modelled (mkdirp is a no-op). */
export interface MemoryFileSystem extends FileSystem {
  readonly files: Map<string, string>;
}

export function memoryFileSystem(seed: Record<string, string> = {}): MemoryFileSystem {
  const files = new Map<string, string>(Object.entries(seed));
  const dirs = new Set<string>();
  return {
    files,
    read: (path) => files.get(path),
    write: (path, content) => {
      // Model the real fs faithfully for the .baron dir: writing into it before it's created is
      // ENOENT (writeFileSync doesn't mkdir parents) — the exact failure a fresh `baron init` hit.
      const parent = path.slice(0, path.lastIndexOf('/'));
      if (parent.endsWith(`/${BARON_DIR}`) && !dirs.has(parent)) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
          code: 'ENOENT',
        });
      }
      files.set(path, content);
    },
    exists: (path) => files.has(path) || dirs.has(path),
    mkdirp: (path) => {
      dirs.add(path);
    },
  };
}

/** {@link Prompter} that replays a fixed list of confirm answers and records notes. */
export interface ScriptedPrompter extends Prompter {
  readonly notes: string[];
}

export function scriptedPrompter(
  answers: readonly boolean[],
  texts: readonly string[] = [],
): ScriptedPrompter {
  const notes: string[] = [];
  let cursor = 0;
  let textCursor = 0;
  return {
    notes,
    note: (message) => {
      notes.push(message);
    },
    confirm: async () => answers[cursor++] ?? false,
    text: async () => texts[textCursor++] ?? '',
  };
}

/** {@link RecipeAsker} that replays scripted text answers and records notes. */
export interface ScriptedAsker extends RecipeAsker {
  readonly notes: string[];
}

export function scriptedAsker(textAnswers: readonly (string | undefined)[] = []): ScriptedAsker {
  const notes: string[] = [];
  let cursor = 0;
  return {
    notes,
    async text() {
      return textAnswers[cursor++];
    },
    async confirm() {
      return true;
    },
    async choice(_message, choices) {
      return choices[0] ?? '';
    },
    note: (message) => {
      notes.push(message);
    },
  };
}
