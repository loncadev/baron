import { BaronError, parsePolicyJson } from '@lonca/baron-core';
import { createLocalKnowledgeLoop } from '@lonca/baron-knowledge-loop';
import {
  type Env,
  buildPorts,
  credentialsPath,
  knowledgeDir,
  upsertCredentials,
} from '@lonca/baron-providers';
import {
  RUN_NOT_FOUND,
  type RecipeAsker,
  type RecipeContext,
  type RunJournalStore,
  type RunRecipeResult,
  createFileRunJournal,
  loadRecipe,
  newRunId,
  resolveRecipeByName,
  runRecipe,
} from '@lonca/baron-recipes';
import { policyPath } from './paths.js';
import type { FileSystem } from './ports.js';

export interface RunRecipeFileOptions {
  readonly root: string;
  /**
   * A built-in or project recipe NAME, or a path to a recipe YAML file. Absent when resuming: the
   * journal already says which recipe the run is.
   */
  readonly recipePath?: string | undefined;
  readonly fs: FileSystem;
  readonly asker: RecipeAsker;
  readonly env: Env;
  /** Pre-seed recipe context (skips the matching `ask` steps). */
  readonly inputs?: RecipeContext;
  /** The id this run is journaled under; a fresh one is minted when absent. */
  readonly runId?: string | undefined;
  /** Continue the run with this id from its journal instead of starting a new one. */
  readonly resume?: string | undefined;
}

/**
 * The journal for a project, through the CLI's own file system so a test sees what was written and
 * so nothing here reaches the disk behind the harness's back. Append is read-then-write: the CLI's
 * file port has no append, and a journal line is short.
 */
export function cliRunJournal(fs: FileSystem, root: string): RunJournalStore {
  return createFileRunJournal(root, {
    read: (path) => fs.read(path),
    append(path, text) {
      fs.write(path, `${fs.read(path) ?? ''}${text}`);
    },
  });
}

/**
 * A `--recipe` value that names a file rather than a recipe: it has a directory separator or a YAML
 * extension. Deciding up front, rather than trying a file read and falling back, is what lets each
 * failure say the right thing — a mistyped path should not be reported as an unknown recipe name.
 */
function looksLikePath(value: string): boolean {
  return /[/\\]/.test(value) || value.endsWith('.yaml') || value.endsWith('.yml');
}

function resolveRecipeArgument(options: RunRecipeFileOptions, recipePath: string) {
  if (!looksLikePath(recipePath)) {
    return resolveRecipeByName(recipePath, options.root);
  }
  const raw = options.fs.read(recipePath);
  if (raw === undefined) {
    throw new BaronError(`No recipe found at ${recipePath}.`, 'RECIPE_NOT_FOUND');
  }
  return loadRecipe(raw);
}

/** The recipe a stopped run was started with — as it was referred to then — from its journal. */
function resumedRecipeSource(journal: RunJournalStore, runId: string): string {
  const start = journal.read(runId)?.find((e) => e.kind === 'start');
  if (start === undefined) {
    throw new BaronError(
      `No run '${runId}' to resume: no journal was written for it under .baron/runs.`,
      RUN_NOT_FOUND,
    );
  }
  return start.source ?? start.recipe;
}

/**
 * `baron run`: load the committed policy, build its live ports, resolve a recipe, and execute it.
 * The recipe carries the workflow opinion; this just wires the policy's ports + the asker to the
 * engine. Credentials come from `env`, never from the policy.
 */
export async function runRecipeFile(options: RunRecipeFileOptions): Promise<RunRecipeResult> {
  const policyRaw = options.fs.read(policyPath(options.root));
  if (policyRaw === undefined) {
    throw new BaronError(
      `No policy found at ${policyPath(options.root)}. Run \`baron init\` first.`,
      'POLICY_NOT_FOUND',
    );
  }
  const ports = {
    ...buildPorts(parsePolicyJson(policyRaw), options.env, undefined, {
      // Through the CLI's own file system, so a test sees the write and a rotated token lands in
      // the same credentials file the recipe's env was read from.
      persistCredentials: (patch) => {
        const path = credentialsPath(options.root);
        options.fs.write(path, upsertCredentials(options.fs.read(path) ?? '', patch));
      },
    }),
    knowledge: createLocalKnowledgeLoop(knowledgeDir(options.root)),
  };

  const journal = cliRunJournal(options.fs, options.root);
  if (options.resume !== undefined) {
    const source = resumedRecipeSource(journal, options.resume);
    return runRecipe(resolveRecipeArgument(options, source), {
      ports,
      asker: options.asker,
      run: { id: options.resume, journal, resume: true },
    });
  }
  if (options.recipePath === undefined) {
    throw new BaronError(
      'run needs --recipe <name-or-path> or --resume <runId>.',
      'RECIPE_NOT_FOUND',
    );
  }
  return runRecipe(resolveRecipeArgument(options, options.recipePath), {
    ports,
    asker: options.asker,
    ...(options.inputs !== undefined ? { inputs: options.inputs } : {}),
    run: { id: options.runId ?? newRunId(), journal, source: options.recipePath },
  });
}
