import {
  BaronError,
  type CiPort,
  type DeployPort,
  ISSUE_LINK_TYPES,
  type IssueLinkType,
  type IssueQuery,
  type IssuesPort,
  type NotifyPort,
  type ScmPort,
  WORKFLOW_ROLES,
  WORK_ITEM_TYPE_ROLES,
  type WorkItemTypeRole,
  type WorkflowRole,
  isIssueLinkType,
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
  RECIPE_OPS,
  type Recipe,
  type RecipeOp,
  type StepCondition,
  isAskStep,
  isDoStep,
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

export interface RunRecipeOptions {
  readonly ports: RecipePorts;
  readonly asker: RecipeAsker;
  /** Pre-seed context variables; an `ask` whose variable is already set is skipped. */
  readonly inputs?: RecipeContext;
}

export interface RunRecipeResult {
  /** Final run context: seeded inputs + each `ask`/`do` step's bound variable. */
  readonly context: RecipeContext;
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

function optStrArray(params: Params, key: string, op: string): string[] | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new BaronError(`Step '${op}' '${key}' must be an array of strings.`, ARGS);
  }
  return value as string[];
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
      `Step '${op}' needs the issues port, which is not configured.`,
      'PORT_UNBOUND',
    );
  }
  return ports.issues;
}

function scm(ports: RecipePorts, op: string): ScmPort {
  if (ports.scm === undefined) {
    throw new BaronError(
      `Step '${op}' needs the scm port, which is not configured.`,
      'PORT_UNBOUND',
    );
  }
  return ports.scm;
}

function knowledge(ports: RecipePorts, op: string): KnowledgeLoop {
  if (ports.knowledge === undefined) {
    throw new BaronError(
      `Step '${op}' needs the knowledge loop, which is not configured.`,
      'PORT_UNBOUND',
    );
  }
  return ports.knowledge;
}

function ci(ports: RecipePorts, op: string): CiPort {
  if (ports.ci === undefined) {
    throw new BaronError(
      `Step '${op}' needs the ci port, which is not configured.`,
      'PORT_UNBOUND',
    );
  }
  return ports.ci;
}

function deploy(ports: RecipePorts, op: string): DeployPort {
  if (ports.deploy === undefined) {
    throw new BaronError(
      `Step '${op}' needs the deploy port, which is not configured.`,
      'PORT_UNBOUND',
    );
  }
  return ports.deploy;
}

function notify(ports: RecipePorts, op: string): NotifyPort {
  if (ports.notify === undefined) {
    throw new BaronError(
      `Step '${op}' needs the notify port, which is not configured.`,
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
    case RECIPE_OPS.issueTransition:
      return issues(ports, op).transition(reqStr(params, 'id', op), reqRole(params, 'role', op));
    case RECIPE_OPS.issueComment:
      return issues(ports, op).comment(reqStr(params, 'id', op), reqStr(params, 'body', op));
    case RECIPE_OPS.issueAssign:
      return issues(ports, op).assign(reqStr(params, 'id', op), reqStr(params, 'assignee', op));
    case RECIPE_OPS.issueLink:
      return issues(ports, op).link(
        reqStr(params, 'fromId', op),
        reqStr(params, 'toId', op),
        reqLinkType(params, 'type', op),
      );
    case RECIPE_OPS.issueQuery: {
      const limit = optNum(params, 'limit', op);
      const assignee = optStr(params, 'assignee', op);
      const query: IssueQuery = {
        ...(optStr(params, 'role', op) !== undefined ? { role: reqRole(params, 'role', op) } : {}),
        ...(optStr(params, 'typeRole', op) !== undefined
          ? { typeRole: reqTypeRole(params, 'typeRole', op) }
          : {}),
        ...(assignee !== undefined ? { assignee } : {}),
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
        ...(optBool(params, 'draft', op) !== undefined
          ? { draft: optBool(params, 'draft', op) }
          : {}),
      });
    case RECIPE_OPS.scmPrThread:
      return scm(ports, op).addPullRequestThread(
        reqStr(params, 'pullRequestId', op),
        reqStr(params, 'body', op),
      );
    case RECIPE_OPS.scmPrStatus:
      return scm(ports, op).prStatus(reqStr(params, 'pullRequestId', op));
    case RECIPE_OPS.scmPrFind: {
      // Null (not undefined) for "no PR", so `as:`-bound context reads unambiguously in messages.
      const found = await scm(ports, op).prForBranch(reqStr(params, 'sourceBranch', op));
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

const REQUIRE = 'RECIPE_REQUIRE';

/** A guard/when operand is "present" unless it resolved to nothing: undefined/null/''/false. */
function isTruthy(value: unknown): boolean {
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

  for (const step of recipe.steps) {
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
      continue;
    }

    if (isRequireStep(step)) {
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
      options.asker.note(String(interpolate(step.message, context)));
      continue;
    }

    if (isDoStep(step)) {
      if (step.when !== undefined && !evalCondition(step.when, context)) continue;
      const params = (interpolate(step.with ?? {}, context) ?? {}) as Params;
      const result = await dispatchOp(options.ports, step.do, params);
      if (step.as !== undefined) context[step.as] = result;
    }
  }

  return { context };
}
