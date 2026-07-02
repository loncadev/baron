import type { RecipeAsker } from '@lonca/baron-recipes';
import type { FileSystem, Prompter } from './ports.js';

/** In-memory {@link FileSystem} keyed by exact path; directories are not modelled (mkdirp is a no-op). */
export interface MemoryFileSystem extends FileSystem {
  readonly files: Map<string, string>;
}

export function memoryFileSystem(seed: Record<string, string> = {}): MemoryFileSystem {
  const files = new Map<string, string>(Object.entries(seed));
  return {
    files,
    read: (path) => files.get(path),
    write: (path, content) => {
      files.set(path, content);
    },
    exists: (path) => files.has(path),
    mkdirp: () => {},
  };
}

/** {@link Prompter} that replays a fixed list of confirm answers and records notes. */
export interface ScriptedPrompter extends Prompter {
  readonly notes: string[];
}

export function scriptedPrompter(answers: readonly boolean[]): ScriptedPrompter {
  const notes: string[] = [];
  let cursor = 0;
  return {
    notes,
    note: (message) => {
      notes.push(message);
    },
    confirm: async () => answers[cursor++] ?? false,
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
