import {
  BaronError,
  type CiPort,
  type DeployPort,
  ISSUE_LINK_TYPES,
  type IssueLinkType,
  type IssueQuery,
  type IssuesPort,
  MERGE_STRATEGIES,
  type NotifyPort,
  PR_ISSUE_RELATIONS,
  PR_STATE_FILTERS,
  type PrIssueRelation,
  type PrStateFilter,
  type ScmPort,
  WORKFLOW_ROLES,
  WORK_ITEM_TYPE_ROLES,
  type WorkItemTypeRole,
  type WorkflowRole,
  isIssueLinkType,
  isMergeStrategy,
  isPrIssueRelation,
  isPrStateFilter,
  isWorkItemTypeRole,
  isWorkflowRole,
} from '@lonca/baron-core';
import {
  type FollowupStatus,
  type KnowledgeLoop,
  isFollowupStatus,
} from '@lonca/baron-knowledge-loop';
import type { RecipeAsker } from './ask.js';
import { type RecipeContext, interpolate } from './interpolate.js';
import {
  type JournalEntry,
  RUN_NOT_FOUND,
  RUN_RECIPE_CHANGED,
  type RunJournalStore,
  recipeFingerprint,
  stepKey,
} from './journal.js';
import {
  RECIPE_OPS,
  type Recipe,
  type RecipeOp,
  type Step,
  type StepCondition,
  isAskStep,
  isDoStep,
  isForEachStep,
  isMessageStep,
  isRequireStep,
} from './recipe.js';

export interface RecipePorts {
  readonly issues?: IssuesPort;
  readonly scm?: ScmPort;
  readonly ci?: CiPort;
  readonly deploy?: DeployPort;
  readonly notify?: NotifyPort;
  readonly knowledge?: KnowledgeLoop;
}

/** Journal this run, and optionally continue one that stopped. */
export interface RunJournalOptions {
  readonly id: string;
  readonly journal: RunJournalStore;
  /** How the caller referred to the recipe (a path, say), kept so a resume can load the same one. */
  readonly source?: string | undefined;
  /**
   * Continue run `id` from its journal: inputs and answers are restored, every `do` step whose key
   * the journal holds is replayed from it rather than executed, and the recipe must be the one the
   * run started with (RUN_RECIPE_CHANGED otherwise).
   */
  readonly resume?: boolean;
}

export interface RunRecipeOptions {
  readonly ports: RecipePorts;
  readonly asker: RecipeAsker;
  /** Pre-seed context variables; an `ask` whose variable is already set is skipped. */
  readonly inputs?: RecipeContext;
  /** Absent: the run leaves no journal and cannot be resumed (tests, embedded callers). */
  readonly run?: RunJournalOptions;
}

export interface RunRecipeResult {
  /** Final run context: seeded inputs + each `ask`/`do` step's bound variable. */
  readonly context: RecipeContext;
  /** The journal this run wrote, when it wrote one — what `resume` takes. */
  readonly runId?: string;
  /** How many `do` steps a resumed run took from the journal instead of executing. */
  readonly replayed?: number;
  /**
   * Every `message` step the run emitted, in order.
   *
   * Collected here rather than left to the asker because the asker a caller supplies decides
   * whether anyone hears it, and the non-interactive one used by the MCP service discards notes
   * entirely — which silently threw away task-land's warning that it could not verify the checks,
   * on the one path every skill actually uses. A recipe's own words about what it just did belong
   * in its result.
   */
  readonly notes: readonly string[];
}

type Params = Record<string, unknown>;
const ARGS = 'RECIPE_ARGS';

function reqStr(params: Params, key: string, op: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new BaronError(`Step '${op}' requires a non-empty string '${key}'.`, ARGS);
  }
  return value;
}

function optStr(params: Params, key: string, op: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new BaronError(`Step '${op}' argument '${key}' must be a string.`, ARGS);
  }
  return value;
}

function reqRole(params: Params, key: string, op: string): WorkflowRole {
  const value = reqStr(params, key, op);
  if (!isWorkflowRole(value)) {
    throw new BaronError(
      `Step '${op}' '${key}'='${value}' is not a role (${WORKFLOW_ROLES.join(', ')}).`,
      ARGS,
    );
  }
  return value;
}

function reqTypeRole(params: Params, key: string, op: string): WorkItemTypeRole {
  const value = reqStr(params, key, op);
  if (!isWorkItemTypeRole(value)) {
    throw new BaronError(
      `Step '${op}' '${key}'='${value}' is not a type role (${WORK_ITEM_TYPE_ROLES.join(', ')}).`,
      ARGS,
    );
  }
  return value;
}

function reqLinkType(params: Params, key: string, op: string): IssueLinkType {
  const value = reqStr(params, key, op);
  if (!isIssueLinkType(value)) {
    throw new BaronError(
      `Step '${op}' '${key}'='${value}' is not a link type (${ISSUE_LINK_TYPES.join(', ')}).`,
      ARGS,
    );
  }
  return value;
}

function optNum(params: Params, key: string, op: string): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BaronError(`Step '${op}' argument '${key}' must be a number.`, ARGS);
  }
  return value;
}

function optBool(params: Params, key: string, op: string): boolean | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new BaronError(`Step '${op}' argument '${key}' must be a boolean.`, ARGS);
  }
  return value;
}

/**
 * A boolean that may arrive as a real boolean (an agent passing recipe inputs) or as the text a human
 * typed at an `ask` step ("yes"/"no"). Both paths reach the same step, so accept both rather than
 * making one of them fail on a type.
 */
function optBoolish(params: Params, key: string, op: string): boolean | undefined {
  const value = params[key];
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['true', 'yes', 'y', '1'].includes(text)) return true;
    if (['false', 'no', 'n', '0'].includes(text)) return false;
  }
  throw new BaronError(`Step '${op}' argument '${key}' must be a boolean (or yes/no).`, ARGS);
}

function optStrArray(params: Params, key: string, op: string): string[] | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new BaronError(`Step '${op}' '${key}' must be an array of strings.`, ARGS);
  }
  return value as string[];
}

function optRelation(params: Params, key: string, op: string): PrIssueRelation | undefined {
  const value = optStr(params, key, op);
  if (value === undefined) return undefined;
  if (!isPrIssueRelation(value)) {
    throw new BaronError(
      `Step '${op}' '${key}'='${value}' must be one of ${PR_ISSUE_RELATIONS.join(', ')}.`,
      ARGS,
    );
  }
  return value;
}

function optStatus(params: Params, op: string): FollowupStatus | undefined {
  const value = optStr(params, 'status', op);
  if (value === undefined) return undefined;
  if (!isFollowupStatus(value)) {
    throw new BaronError(`Step '${op}' 'status'='${value}' must be 'open' or 'done'.`, ARGS);
  }
  return value;
}

function issues(ports: RecipePorts, op: string): IssuesPort {
  if (ports.issues === undefined) {
    throw new BaronError(
      `Step '${op}' needs the issues port, which is not configured. Set policy.providers.issues, or re-run \`baron init\`.`,
      'PORT_UNBOUND',
    );
  }
  return ports.issues;
}

function scm(ports: RecipePorts, op: string): ScmPort {
  if (ports.scm === undefined) {
    throw new BaronError(
      `Step '${op}' needs the scm port, which is not configured. Set policy.providers.scm, or re-run \`baron init\`.`,
      'PORT_UNBOUND',
    );
  }
  return ports.scm;
}

function knowledge(ports: RecipePorts, op: string): KnowledgeLoop {
  if (ports.knowledge === undefined) {
    throw new BaronError(
      `Step '${op}' needs the knowledge loop, which this installation does not have configured.`,
      'PORT_UNBOUND',
    );
  }
  return ports.knowledge;
}

function ci(ports: RecipePorts, op: string): CiPort {
  if (ports.ci === undefined) {
    throw new BaronError(
      `Step '${op}' needs the ci port, which is not configured. Set policy.providers.ci, or re-run \`baron init\`.`,
      'PORT_UNBOUND',
    );
  }
  return ports.ci;
}

function deploy(ports: RecipePorts, op: string): DeployPort {
  if (ports.deploy === undefined) {
    throw new BaronError(
      `Step '${op}' needs the deploy port, which is not configured. Set policy.providers.deploy, or re-run \`baron init\`.`,
      'PORT_UNBOUND',
    );
  }
  return ports.deploy;
}

function notify(ports: RecipePorts, op: string): NotifyPort {
  if (ports.notify === undefined) {
    throw new BaronError(
      `Step '${op}' needs the notify port, which is not configured. Set policy.providers.notify, or re-run \`baron init\`.`,
      'PORT_UNBOUND',
    );
  }
  return ports.notify;
}

function optStrRecord(params: Params, key: string, op: string): Record<string, string> | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BaronError(`Step '${op}' '${key}' must be an object of string values.`, ARGS);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') {
      throw new BaronError(`Step '${op}' '${key}.${k}' must be a string.`, ARGS);
    }
    out[k] = v;
  }
  return out;
}

/**
 * An object whose values are left alone — the answers a gated transition's screen wants, which the
 * core hands to the provider untouched. Only the container's shape is the engine's business.
 */
function optRecord(params: Params, key: string, op: string): Record<string, unknown> | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BaronError(`Step '${op}' '${key}' must be an object.`, ARGS);
  }
  return { ...(value as Record<string, unknown>) };
}

/** Map a recipe op + resolved params onto the corresponding port call. */
async function dispatchOp(ports: RecipePorts, op: RecipeOp, params: Params): Promise<unknown> {
  switch (op) {
    case RECIPE_OPS.issueCreate:
      return issues(ports, op).create({
        title: reqStr(params, 'title', op),
        typeRole: reqTypeRole(params, 'typeRole', op),
        ...(optStr(params, 'body', op) !== undefined ? { body: optStr(params, 'body', op) } : {}),
        ...(optStr(params, 'parentId', op) !== undefined
          ? { parentId: optStr(params, 'parentId', op) }
          : {}),
        ...(optStrArray(params, 'labels', op) !== undefined
          ? { labels: optStrArray(params, 'labels', op) }
          : {}),
        ...(optStr(params, 'initialRole', op) !== undefined
          ? { initialRole: reqRole(params, 'initialRole', op) }
          : {}),
      });
    case RECIPE_OPS.issueGet:
      return issues(ports, op).get(reqStr(params, 'id', op));
    case RECIPE_OPS.issueUpdate: {
      const title = optStr(params, 'title', op);
      const body = optStr(params, 'body', op);
      return issues(ports, op).update(reqStr(params, 'id', op), {
        ...(title !== undefined ? { title } : {}),
        ...(body !== undefined ? { body } : {}),
      });
    }
    case RECIPE_OPS.issueTransition: {
      const fields = optRecord(params, 'fields', op);
      return issues(ports, op).transition(
        reqStr(params, 'id', op),
        reqRole(params, 'role', op),
        fields !== undefined ? { fields } : undefined,
      );
    }
    // Read-only: what the move WOULD be. The lifecycle order is core vocabulary; what to do about a
    // regress is the recipe's opinion, which is why this answers rather than decides.
    case RECIPE_OPS.issueClassify:
      return issues(ports, op).classifyMove(reqStr(params, 'id', op), reqRole(params, 'role', op));
    // Blocking is orthogonal, so it is its own op rather than a role a transition could take.
    case RECIPE_OPS.issueBlock:
      return issues(ports, op).block(reqStr(params, 'id', op), reqStr(params, 'reason', op));
    case RECIPE_OPS.issueUnblock: {
      const reason = optStr(params, 'reason', op);
      const port = issues(ports, op);
      const id = reqStr(params, 'id', op);
      return reason === undefined ? port.unblock(id) : port.unblock(id, reason);
    }
    case RECIPE_OPS.issueComment:
      return issues(ports, op).comment(reqStr(params, 'id', op), reqStr(params, 'body', op));
    case RECIPE_OPS.issueAssign:
      return issues(ports, op).assign(reqStr(params, 'id', op), reqStr(params, 'assignee', op));
    case RECIPE_OPS.issueWhoami:
      return issues(ports, op).whoAmI();
    case RECIPE_OPS.issueIterations:
      return issues(ports, op).iterations();
    case RECIPE_OPS.issueSetIteration:
      return issues(ports, op).setIteration(
        reqStr(params, 'id', op),
        reqStr(params, 'iteration', op),
      );
    case RECIPE_OPS.issueLink:
      return issues(ports, op).link(
        reqStr(params, 'fromId', op),
        reqStr(params, 'toId', op),
        reqLinkType(params, 'type', op),
      );
    case RECIPE_OPS.issueQuery: {
      const limit = optNum(params, 'limit', op);
      const assignee = optStr(params, 'assignee', op);
      const iteration = optStr(params, 'iteration', op);
      const query: IssueQuery = {
        ...(optStr(params, 'role', op) !== undefined ? { role: reqRole(params, 'role', op) } : {}),
        ...(optStr(params, 'typeRole', op) !== undefined
          ? { typeRole: reqTypeRole(params, 'typeRole', op) }
          : {}),
        ...(assignee !== undefined ? { assignee } : {}),
        ...(iteration !== undefined ? { iteration } : {}),
        ...(limit !== undefined ? { limit } : {}),
      };
      return issues(ports, op).query(query);
    }
    case RECIPE_OPS.scmBranchCreate:
      return scm(ports, op).createBranch({
        name: reqStr(params, 'name', op),
        ...(optStr(params, 'fromBranch', op) !== undefined
          ? { fromBranch: optStr(params, 'fromBranch', op) }
          : {}),
      });
    case RECIPE_OPS.scmPrCreate:
      return scm(ports, op).createPullRequest({
        title: reqStr(params, 'title', op),
        sourceBranch: reqStr(params, 'sourceBranch', op),
        ...(optStr(params, 'targetBranch', op) !== undefined
          ? { targetBranch: optStr(params, 'targetBranch', op) }
          : {}),
        ...(optStr(params, 'body', op) !== undefined ? { body: optStr(params, 'body', op) } : {}),
        ...(optStr(params, 'linkedIssueKey', op) !== undefined
          ? { linkedIssueKey: optStr(params, 'linkedIssueKey', op) }
          : {}),
        ...(optRelation(params, 'linkedIssueRelation', op) !== undefined
          ? { linkedIssueRelation: optRelation(params, 'linkedIssueRelation', op) }
          : {}),
        ...(optStrArray(params, 'assignees', op) !== undefined
          ? { assignees: optStrArray(params, 'assignees', op) }
          : {}),
        ...(optBoolish(params, 'autoComplete', op) !== undefined
          ? { autoComplete: optBoolish(params, 'autoComplete', op) }
          : {}),
        ...(optBool(params, 'draft', op) !== undefined
          ? { draft: optBool(params, 'draft', op) }
          : {}),
      });
    case RECIPE_OPS.scmPrThread:
      return scm(ports, op).addPullRequestThread(
        reqStr(params, 'pullRequestId', op),
        reqStr(params, 'body', op),
      );
    case RECIPE_OPS.issueReconcile:
      return issues(ports, op).reconcile(reqStr(params, 'id', op));
    case RECIPE_OPS.scmPrReady:
      return scm(ports, op).markPrReady(reqStr(params, 'pullRequestId', op));
    case RECIPE_OPS.scmPrMerge: {
      const strategy = optStr(params, 'strategy', op);
      if (strategy !== undefined && !isMergeStrategy(strategy)) {
        throw new BaronError(
          `Step '${op}' 'strategy'='${strategy}' must be one of ${MERGE_STRATEGIES.join(', ')}.`,
          ARGS,
        );
      }
      const deleteSourceBranch = optBoolish(params, 'deleteSourceBranch', op);
      return scm(ports, op).mergePr(reqStr(params, 'pullRequestId', op), {
        ...(strategy !== undefined ? { strategy } : {}),
        ...(deleteSourceBranch !== undefined ? { deleteSourceBranch } : {}),
      });
    }
    case RECIPE_OPS.scmPrStatus:
      return scm(ports, op).prStatus(reqStr(params, 'pullRequestId', op));
    case RECIPE_OPS.scmPrFind: {
      const stateFilter = optStr(params, 'state', op);
      if (stateFilter !== undefined && !isPrStateFilter(stateFilter)) {
        throw new BaronError(
          `Step '${op}' 'state'='${stateFilter}' must be one of ${PR_STATE_FILTERS.join(', ')}.`,
          ARGS,
        );
      }
      // Null (not undefined) for "no PR", so `as:`-bound context reads unambiguously in messages.
      const found = await scm(ports, op).prForBranch(
        reqStr(params, 'sourceBranch', op),
        stateFilter as PrStateFilter | undefined,
      );
      return found ?? null;
    }
    case RECIPE_OPS.ciRunTrigger: {
      const ref = optStr(params, 'ref', op);
      const variables = optStrRecord(params, 'variables', op);
      return ci(ports, op).trigger({
        pipelineId: reqStr(params, 'pipelineId', op),
        ...(ref !== undefined ? { ref } : {}),
        ...(variables !== undefined ? { variables } : {}),
      });
    }
    case RECIPE_OPS.ciRunCancel:
      return ci(ports, op).cancel(reqStr(params, 'runId', op));
    case RECIPE_OPS.deployDeployments: {
      const environment = optStr(params, 'environment', op);
      const limit = optNum(params, 'limit', op);
      return deploy(ports, op).deployments({
        ...(environment !== undefined ? { environment } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
    }
    case RECIPE_OPS.notifySend: {
      const channel = optStr(params, 'channel', op);
      const threadKey = optStr(params, 'threadKey', op);
      return notify(ports, op).send({
        text: reqStr(params, 'text', op),
        ...(channel !== undefined ? { channel } : {}),
        ...(threadKey !== undefined ? { threadKey } : {}),
      });
    }
    case RECIPE_OPS.learningAppend: {
      const tags = optStrArray(params, 'tags', op);
      return knowledge(ports, op).learningAppend({
        title: reqStr(params, 'title', op),
        body: reqStr(params, 'body', op),
        ...(tags !== undefined ? { tags } : {}),
      });
    }
    case RECIPE_OPS.learningQuery: {
      const tag = optStr(params, 'tag', op);
      const text = optStr(params, 'text', op);
      const limit = optNum(params, 'limit', op);
      return knowledge(ports, op).learningQuery({
        ...(tag !== undefined ? { tag } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
    }
    case RECIPE_OPS.followupAppend: {
      const body = optStr(params, 'body', op);
      const tags = optStrArray(params, 'tags', op);
      return knowledge(ports, op).followupAppend({
        title: reqStr(params, 'title', op),
        ...(body !== undefined ? { body } : {}),
        ...(tags !== undefined ? { tags } : {}),
      });
    }
    case RECIPE_OPS.followupList: {
      const status = optStatus(params, op);
      const tag = optStr(params, 'tag', op);
      const limit = optNum(params, 'limit', op);
      return knowledge(ports, op).followupList({
        ...(status !== undefined ? { status } : {}),
        ...(tag !== undefined ? { tag } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
    }
    default: {
      // Exhaustiveness guard: a new RecipeOp without a case lands here at compile time.
      const unreachable: never = op;
      throw new BaronError(`Unhandled recipe op '${String(unreachable)}'.`, 'RECIPE_OP');
    }
  }
}

/** A `for_each` pointed at something that is not a list — an authoring mistake, not empty data. */
const FOR_EACH_NOT_A_LIST = 'FOR_EACH_NOT_A_LIST';

const REQUIRE = 'RECIPE_REQUIRE';

/** A guard/when operand is "present" unless it resolved to nothing: undefined/null/''/false. */
function isTruthy(value: unknown): boolean {
  // The NUMBER zero is falsy — it is always a count or a total here (`found.length`,
  // `checks.failed`), and "none" reading as true made `truthy: ${found.length}` pass on an empty
  // result, which is the opposite of what anyone writing that guard means. The STRING '0' stays
  // truthy: work-item ids are strings, and an item numbered 0 is present, not absent.
  if (value === 0) return false;
  return value !== undefined && value !== null && value !== '' && value !== false;
}

/** Interpolated string comparison; absent operands compare as ''. */
function asComparable(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function evalCondition(condition: StepCondition, context: RecipeContext): boolean {
  if (condition.truthy !== undefined) return isTruthy(interpolate(condition.truthy, context));
  if (condition.falsy !== undefined) return !isTruthy(interpolate(condition.falsy, context));
  if (condition.equals !== undefined) {
    const [a, b] = condition.equals;
    return asComparable(interpolate(a, context)) === asComparable(interpolate(b, context));
  }
  if (condition.notEquals !== undefined) {
    const [a, b] = condition.notEquals;
    return asComparable(interpolate(a, context)) !== asComparable(interpolate(b, context));
  }
  // Unreachable for a parsed recipe (the parser enforces exactly one key).
  throw new BaronError('Empty step condition.', REQUIRE);
}

/**
 * Execute a recipe step by step against the injected ports, threading a context: `ask` steps gather
 * typed human input (skipped when pre-seeded), `do` steps call a primitive and bind its result,
 * `message` steps surface a line, `require` steps are engine-enforced guards (decision #19: the
 * rules live in the engine, not in agent judgement), and a `when:` condition skips a do/message
 * step. All workflow opinion lives in the recipe; this engine is pure mechanism (invariant #3) and
 * does no role/native translation (that stays in the ports, #4).
 */
export async function runRecipe(
  recipe: Recipe,
  options: RunRecipeOptions,
): Promise<RunRecipeResult> {
  const context: RecipeContext = { ...options.inputs };
  const notes: string[] = [];
  const run = options.run;
  if (run === undefined) {
    await runSteps(recipe.steps, context, notes, options, undefined, '');
    return { context, notes };
  }

  const state = openJournal(recipe, run, context);
  try {
    await runSteps(recipe.steps, context, notes, options, state, '');
  } catch (error) {
    const at = state.current;
    state.journal.append(run.id, {
      kind: 'error',
      at: now(),
      ...(at !== undefined ? { path: at.path, op: at.op } : {}),
      ...(error instanceof BaronError ? { code: error.code } : {}),
      message: error instanceof Error ? error.message : String(error),
    });
    throw withRun(error, run.id, at);
  }
  state.journal.append(run.id, { kind: 'end', at: now(), replayed: state.replayed });
  return { context, notes, runId: run.id, replayed: state.replayed };
}

const now = (): string => new Date().toISOString();

type DoEntry = Extract<JournalEntry, { kind: 'do' }>;

/** What the engine carries through a journaled run. */
interface JournalState {
  readonly id: string;
  readonly journal: RunJournalStore;
  /** Completed `do` steps of the run being resumed, by idempotency key. */
  readonly done: ReadonlyMap<string, DoEntry>;
  replayed: number;
  /** The step executing right now, so an error entry can say where the run stopped. */
  current?: { readonly path: string; readonly op: string } | undefined;
}

/**
 * Write the start entry of a fresh run, or load the journal of the run being resumed and restore
 * what it answered. A resumed run must be the same recipe: replaying step results against changed
 * instructions would bind values produced by different steps, which is worse than starting over.
 */
function openJournal(recipe: Recipe, run: RunJournalOptions, context: RecipeContext): JournalState {
  const fingerprint = recipeFingerprint(recipe);
  const done = new Map<string, DoEntry>();
  if (run.resume !== true) {
    run.journal.append(run.id, {
      kind: 'start',
      at: now(),
      recipe: recipe.name,
      ...(run.source !== undefined ? { source: run.source } : {}),
      fingerprint,
      inputs: { ...context },
    });
    return { id: run.id, journal: run.journal, done, replayed: 0 };
  }

  const entries = run.journal.read(run.id);
  const start = entries?.find(
    (e): e is Extract<JournalEntry, { kind: 'start' }> => e.kind === 'start',
  );
  if (entries === undefined || start === undefined) {
    throw new BaronError(
      `No run '${run.id}' to resume: no journal was written for it.`,
      RUN_NOT_FOUND,
    );
  }
  if (start.recipe !== recipe.name || start.fingerprint !== fingerprint) {
    throw new BaronError(
      `Run '${run.id}' started with recipe '${start.recipe}' as it was then; the recipe has changed since, so its completed steps cannot be replayed safely. Start a new run.`,
      RUN_RECIPE_CHANGED,
    );
  }
  if (entries.some((e) => e.kind === 'end')) {
    throw new BaronError(
      `Run '${run.id}' already finished; there is nothing to resume.`,
      RUN_NOT_FOUND,
    );
  }
  // Inputs first, then the answers given along the way; an ask restored here is not asked again.
  Object.assign(context, start.inputs);
  for (const entry of entries) {
    if (entry.kind === 'ask') context[entry.as] = entry.value;
    if (entry.kind === 'do') done.set(entry.key, entry);
  }
  run.journal.append(run.id, { kind: 'resume', at: now() });
  return { id: run.id, journal: run.journal, done, replayed: 0 };
}

/**
 * Attach the run to the error a caller sees, without changing its class or message: `details.run`
 * names the run id and the step it stopped at, which is what the resume hint is built from.
 */
function withRun(
  error: unknown,
  runId: string,
  at: { readonly path: string; readonly op: string } | undefined,
): unknown {
  if (!(error instanceof BaronError)) return error;
  const run = { id: runId, ...(at !== undefined ? { step: at.path, op: at.op } : {}) };
  Object.defineProperty(error, 'details', {
    value: { ...error.details, run },
    enumerable: true,
    configurable: true,
    writable: false,
  });
  return error;
}

/**
 * Run a list of steps against one context. Extracted so `for_each` can run its nested steps through
 * exactly the same machinery — a loop whose body behaved differently from the top level would be a
 * second, quieter language.
 */
async function runSteps(
  steps: readonly Step[],
  context: RecipeContext,
  notes: string[],
  options: RunRecipeOptions,
  state: JournalState | undefined,
  /** Journal path prefix of these steps: '' at the top level, `3[1]/` inside a for_each. */
  path: string,
): Promise<void> {
  for (const [index, step] of steps.entries()) {
    if (isAskStep(step)) {
      const { as, type, message, choices, optional } = step.ask;
      if (context[as] !== undefined) continue; // pre-seeded; don't re-ask
      if (type === 'confirm') {
        context[as] = await options.asker.confirm(message);
      } else if (type === 'choice') {
        context[as] = await options.asker.choice(message, choices ?? []);
      } else {
        context[as] = await options.asker.text(message, optional === true);
      }
      // Journaled even when the answer is nothing: a resumed run must not ask again.
      state?.journal.append(state.id, { kind: 'ask', at: now(), as, value: context[as] ?? null });
      continue;
    }

    if (isRequireStep(step)) {
      // A `when` makes the guard conditional: skip enforcement unless the precondition holds.
      if (step.when !== undefined && !evalCondition(step.when, context)) continue;
      const { message, ...condition } = step.require;
      if (!evalCondition(condition, context)) {
        // The message is authored for the human: interpolated, actionable, and it STOPS the run —
        // a failed guard must never fall through to the mutation steps below it.
        throw new BaronError(String(interpolate(message, context)), REQUIRE);
      }
      continue;
    }

    if (isMessageStep(step)) {
      if (step.when !== undefined && !evalCondition(step.when, context)) continue;
      const note = String(interpolate(step.message, context));
      notes.push(note);
      options.asker.note(note);
      state?.journal.append(state.id, { kind: 'note', at: now(), text: note });
      continue;
    }

    if (isDoStep(step)) {
      if (step.when !== undefined && !evalCondition(step.when, context)) continue;
      const params = (interpolate(step.with ?? {}, context) ?? {}) as Params;
      if (state === undefined) {
        const result = await dispatchOp(options.ports, step.do, params);
        if (step.as !== undefined) context[step.as] = result;
        continue;
      }
      const stepPath = `${path}${index}`;
      const key = stepKey(state.id, stepPath, step.do, params);
      const earlier = state.done.get(key);
      if (earlier !== undefined) {
        // Already done before the run stopped: the provider was mutated then, and doing it again is
        // the duplicate PR this journal exists to prevent. Its result is bound as if it had run.
        if (step.as !== undefined) context[step.as] = earlier.result;
        state.replayed += 1;
        const note = `Replayed ${step.do} from run ${state.id} (already done at ${earlier.at}).`;
        notes.push(note);
        options.asker.note(note);
        continue;
      }
      state.current = { path: stepPath, op: step.do };
      const result = await dispatchOp(options.ports, step.do, params);
      state.current = undefined;
      if (step.as !== undefined) context[step.as] = result;
      state.journal.append(state.id, {
        kind: 'do',
        at: now(),
        path: stepPath,
        op: step.do,
        key,
        ...(step.as !== undefined ? { as: step.as } : {}),
        ...(result !== undefined ? { result } : {}),
      });
      continue;
    }

    if (isForEachStep(step)) {
      if (step.when !== undefined && !evalCondition(step.when, context)) continue;
      const list = interpolate(step.for_each, context);
      if (!Array.isArray(list)) {
        // Not an empty run: sweeping something that is not a list is a mistake in the recipe, and
        // quietly doing nothing is how a sweep reports "all clear" for a board it never read.
        throw new BaronError(
          `Step 'for_each' expected a list at '${step.for_each}', found ` +
            `${list === undefined ? 'nothing' : typeof list}.`,
          FOR_EACH_NOT_A_LIST,
        );
      }
      const collected: unknown[] = [];
      for (const [position, element] of list.entries()) {
        // One scope per iteration. Bindings made inside must not leak: otherwise the last element
        // silently wins for anything read after the loop, which looks like data rather than a bug.
        const scope: RecipeContext = { ...context, [step.as]: element };
        await runSteps(step.steps, scope, notes, options, state, `${path}${index}[${position}]/`);
        if (step.collect !== undefined) {
          const gate = step.collect.when;
          if (gate !== undefined && !evalCondition(gate, scope)) continue;
          const value = interpolate(step.collect.from, scope);
          if (value !== undefined && value !== null && value !== '') collected.push(value);
        }
      }
      // Bound even when nothing matched, so a recipe can say "0 items" rather than interpolate a
      // reference that resolves to nothing.
      if (step.collect !== undefined) context[step.collect.as] = collected;
    }
  }
}
