import { BaronError } from '@baron/core';
import { parse as parseYaml } from 'yaml';

/**
 * The primitive operations a recipe step may invoke, mapped 1:1 onto the issues/scm port methods.
 * Centralized so step `do:` values are not magic strings and the engine dispatch stays exhaustive.
 */
export const RECIPE_OPS = {
  issueCreate: 'issue.create',
  issueTransition: 'issue.transition',
  issueComment: 'issue.comment',
  issueLink: 'issue.link',
  issueQuery: 'issue.query',
  scmBranchCreate: 'scm.branch.create',
  scmPrCreate: 'scm.pr.create',
  scmPrThread: 'scm.pr.thread',
} as const;

export type RecipeOp = (typeof RECIPE_OPS)[keyof typeof RECIPE_OPS];

const RECIPE_OP_VALUES: readonly string[] = Object.values(RECIPE_OPS);

export function isRecipeOp(value: string): value is RecipeOp {
  return RECIPE_OP_VALUES.includes(value);
}

export const ASK_TYPES = ['text', 'confirm', 'choice'] as const;
export type AskType = (typeof ASK_TYPES)[number];

/** A typed prompt for human input (decision #7); rendered per harness by the {@link RecipeAsker}. */
export interface AskSpec {
  /** Context variable the answer is bound to. */
  readonly as: string;
  readonly type: AskType;
  readonly message: string;
  /** Allowed values for `type: choice`. */
  readonly choices?: readonly string[];
  /** When true, a `text` ask may be skipped (yields undefined). */
  readonly optional?: boolean;
}

export interface AskStep {
  readonly ask: AskSpec;
}

export interface DoStep {
  readonly do: RecipeOp;
  /** Step parameters; string values may contain `${path}` references into the run context. */
  readonly with?: Record<string, unknown>;
  /** Context variable the step result is bound to. */
  readonly as?: string;
}

export interface MessageStep {
  readonly message: string;
}

export type Step = AskStep | DoStep | MessageStep;

export interface Recipe {
  readonly name: string;
  readonly description?: string;
  readonly steps: readonly Step[];
}

export function isAskStep(step: Step): step is AskStep {
  return 'ask' in step;
}
export function isDoStep(step: Step): step is DoStep {
  return 'do' in step;
}
export function isMessageStep(step: Step): step is MessageStep {
  return 'message' in step;
}

const PARSE_CODE = 'RECIPE_PARSE';

function fail(message: string): never {
  throw new BaronError(message, PARSE_CODE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAsk(raw: unknown, where: string): AskStep {
  const ask = isRecord(raw) ? raw.ask : undefined;
  if (!isRecord(ask)) fail(`${where}: 'ask' must be an object.`);
  const { as, type, message, choices, optional } = ask;
  if (typeof as !== 'string' || as.length === 0)
    fail(`${where}: ask.as must be a non-empty string.`);
  if (typeof type !== 'string' || !(ASK_TYPES as readonly string[]).includes(type)) {
    fail(`${where}: ask.type must be one of ${ASK_TYPES.join(', ')}.`);
  }
  if (typeof message !== 'string' || message.length === 0) {
    fail(`${where}: ask.message must be a non-empty string.`);
  }
  if (type === 'choice' && (!Array.isArray(choices) || choices.length === 0)) {
    fail(`${where}: ask.choices is required and must be non-empty for a 'choice' ask.`);
  }
  if (
    choices !== undefined &&
    (!Array.isArray(choices) || choices.some((c) => typeof c !== 'string'))
  ) {
    fail(`${where}: ask.choices must be an array of strings.`);
  }
  if (optional !== undefined && typeof optional !== 'boolean') {
    fail(`${where}: ask.optional must be a boolean.`);
  }
  return {
    ask: {
      as,
      type: type as AskType,
      message,
      ...(choices !== undefined ? { choices: choices as string[] } : {}),
      ...(optional !== undefined ? { optional } : {}),
    },
  };
}

function parseDo(raw: Record<string, unknown>, where: string): DoStep {
  const op = raw.do;
  if (typeof op !== 'string' || !isRecipeOp(op)) {
    fail(`${where}: 'do' must be one of ${RECIPE_OP_VALUES.join(', ')}.`);
  }
  const { with: withParams, as } = raw;
  if (withParams !== undefined && !isRecord(withParams)) {
    fail(`${where}: 'with' must be an object.`);
  }
  if (as !== undefined && (typeof as !== 'string' || as.length === 0)) {
    fail(`${where}: 'as' must be a non-empty string.`);
  }
  return {
    do: op as RecipeOp,
    ...(withParams !== undefined ? { with: withParams as Record<string, unknown> } : {}),
    ...(as !== undefined ? { as: as as string } : {}),
  };
}

function parseStep(raw: unknown, index: number): Step {
  const where = `steps[${index}]`;
  if (!isRecord(raw)) fail(`${where} must be an object.`);
  if ('ask' in raw) return parseAsk(raw, where);
  if ('do' in raw) return parseDo(raw, where);
  if ('message' in raw) {
    if (typeof raw.message !== 'string') fail(`${where}: 'message' must be a string.`);
    return { message: raw.message };
  }
  fail(`${where} must have one of 'ask', 'do', or 'message'.`);
}

/**
 * Validate an untrusted object (typically `YAML.parse` of a recipe file) into a typed {@link Recipe}.
 * Throws {@link BaronError} (`RECIPE_PARSE`) with an actionable, pathed message on any violation.
 */
export function parseRecipe(raw: unknown): Recipe {
  if (!isRecord(raw)) fail('recipe must be an object.');
  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    fail('recipe.name must be a non-empty string.');
  }
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    fail('recipe.description must be a string.');
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    fail('recipe.steps must be a non-empty array.');
  }
  return {
    name: raw.name,
    ...(raw.description !== undefined ? { description: raw.description as string } : {}),
    steps: raw.steps.map(parseStep),
  };
}

/** Parse a recipe from YAML text. */
export function loadRecipe(yamlText: string): Recipe {
  return parseRecipe(parseYaml(yamlText));
}
