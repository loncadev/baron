import { BaronError } from '@lonca/baron-core';
import { parse as parseYaml } from 'yaml';

/**
 * The primitive operations a recipe step may invoke, mapped 1:1 onto the issues/scm port methods.
 * Centralized so step `do:` values are not magic strings and the engine dispatch stays exhaustive.
 */
export const RECIPE_OPS = {
  issueCreate: 'issue.create',
  issueGet: 'issue.get',
  issueTransition: 'issue.transition',
  issueComment: 'issue.comment',
  issueLink: 'issue.link',
  issueAssign: 'issue.assign',
  issueIterations: 'issue.iterations',
  issueSetIteration: 'issue.set-iteration',
  issueQuery: 'issue.query',
  scmBranchCreate: 'scm.branch.create',
  scmPrCreate: 'scm.pr.create',
  scmPrThread: 'scm.pr.thread',
  scmPrStatus: 'scm.pr.status',
  scmPrFind: 'scm.pr.find',
  ciRunTrigger: 'ci.run.trigger',
  ciRunCancel: 'ci.run.cancel',
  deployDeployments: 'deploy.deployments',
  notifySend: 'notify.send',
  learningAppend: 'learning.append',
  learningQuery: 'learning.query',
  followupAppend: 'followup.append',
  followupList: 'followup.list',
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

/**
 * A declarative condition over the run context. Exactly ONE key; operands are interpolated before
 * evaluation. Deliberately not an expression language: four primitive tests cover the reference
 * guards (refuse-if-closed, refuse-containers, skip-when-PR-exists) without opening a parser
 * attack/maintenance surface.
 */
export interface StepCondition {
  /** True when the interpolated value is present and not ''/false/null. */
  readonly truthy?: string;
  /** True when the interpolated value is absent, '', false, or null. */
  readonly falsy?: string;
  /** True when both interpolated operands are equal (string comparison). */
  readonly equals?: readonly [string, string];
  /** True when the interpolated operands differ (string comparison). */
  readonly notEquals?: readonly [string, string];
}

/** A guard: when the condition is false the run STOPS with the (interpolated) message. */
export interface RequireStep {
  readonly require: StepCondition & { readonly message: string };
}

export interface DoStep {
  readonly do: RecipeOp;
  /** Step parameters; string values may contain `${path}` references into the run context. */
  readonly with?: Record<string, unknown>;
  /** Context variable the step result is bound to. */
  readonly as?: string;
  /** Run the step only when the condition holds; otherwise it is skipped (its `as` stays unset). */
  readonly when?: StepCondition;
}

export interface MessageStep {
  readonly message: string;
  /** Emit the message only when the condition holds. */
  readonly when?: StepCondition;
}

export type Step = AskStep | DoStep | MessageStep | RequireStep;

export interface Recipe {
  readonly name: string;
  readonly description?: string;
  readonly steps: readonly Step[];
}

/** A declared input a recipe gathers via an `ask` step — surfaced so a caller can collect them upfront. */
export interface RecipeInput {
  readonly name: string;
  readonly message: string;
  readonly type: AskType;
  readonly optional: boolean;
  readonly choices?: readonly string[];
}

/** The inputs a recipe's `ask` steps gather, in order — used to drive non-interactive runs. */
export function recipeInputs(recipe: Recipe): RecipeInput[] {
  return recipe.steps.filter(isAskStep).map((step) => ({
    name: step.ask.as,
    message: step.ask.message,
    type: step.ask.type,
    optional: step.ask.optional === true,
    ...(step.ask.choices !== undefined ? { choices: step.ask.choices } : {}),
  }));
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
export function isRequireStep(step: Step): step is RequireStep {
  return 'require' in step;
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

const CONDITION_KEYS = ['truthy', 'falsy', 'equals', 'notEquals'] as const;

function parseCondition(raw: unknown, where: string): StepCondition {
  if (!isRecord(raw)) fail(`${where} must be an object.`);
  const present = CONDITION_KEYS.filter((key) => raw[key] !== undefined);
  if (present.length !== 1) {
    fail(
      `${where} must have exactly one of ${CONDITION_KEYS.join(', ')} (found: ${present.join(', ') || 'none'}).`,
    );
  }
  const key = present[0] as (typeof CONDITION_KEYS)[number];
  const value = raw[key];
  if (key === 'truthy' || key === 'falsy') {
    if (typeof value !== 'string' || value.length === 0) {
      fail(`${where}.${key} must be a non-empty string.`);
    }
    return key === 'truthy' ? { truthy: value } : { falsy: value };
  }
  if (!Array.isArray(value) || value.length !== 2 || value.some((v) => typeof v !== 'string')) {
    fail(`${where}.${key} must be an array of exactly two strings.`);
  }
  const pair = value as [string, string];
  return key === 'equals' ? { equals: pair } : { notEquals: pair };
}

function parseRequire(raw: Record<string, unknown>, where: string): RequireStep {
  const req = raw.require;
  if (!isRecord(req)) fail(`${where}: 'require' must be an object.`);
  if (typeof req.message !== 'string' || req.message.length === 0) {
    fail(`${where}: require.message must be a non-empty string (it is what the user sees).`);
  }
  const { message, ...condition } = req;
  return { require: { ...parseCondition(condition, `${where}.require`), message } };
}

function parseWhen(raw: Record<string, unknown>, where: string): StepCondition | undefined {
  return raw.when === undefined ? undefined : parseCondition(raw.when, `${where}.when`);
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
  const when = parseWhen(raw, where);
  return {
    do: op as RecipeOp,
    ...(withParams !== undefined ? { with: withParams as Record<string, unknown> } : {}),
    ...(as !== undefined ? { as: as as string } : {}),
    ...(when !== undefined ? { when } : {}),
  };
}

function parseStep(raw: unknown, index: number): Step {
  const where = `steps[${index}]`;
  if (!isRecord(raw)) fail(`${where} must be an object.`);
  // A step must be exactly one kind; a step with e.g. both `ask` and `do` is a typo, not a silent
  // "pick the first" — dropping the other key would run a different program than the author wrote.
  const kinds = ['ask', 'do', 'message', 'require'].filter((kind) => kind in raw);
  if (kinds.length !== 1) {
    fail(
      `${where} must have exactly one of 'ask', 'do', 'message', or 'require' (found: ${kinds.join(', ') || 'none'}).`,
    );
  }
  if ('ask' in raw) return parseAsk(raw, where);
  if ('do' in raw) return parseDo(raw, where);
  if ('require' in raw) return parseRequire(raw, where);
  if (typeof raw.message !== 'string') fail(`${where}: 'message' must be a string.`);
  const when = parseWhen(raw, where);
  return { message: raw.message, ...(when !== undefined ? { when } : {}) };
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
