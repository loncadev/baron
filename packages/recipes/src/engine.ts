import {
  BaronError,
  ISSUE_LINK_TYPES,
  type IssueLinkType,
  type IssueQuery,
  type IssuesPort,
  type ScmPort,
  WORKFLOW_ROLES,
  WORK_ITEM_TYPE_ROLES,
  type WorkItemTypeRole,
  type WorkflowRole,
  isIssueLinkType,
  isWorkItemTypeRole,
  isWorkflowRole,
} from '@baron/core';
import type { RecipeAsker } from './ask.js';
import { type RecipeContext, interpolate } from './interpolate.js';
import {
  RECIPE_OPS,
  type Recipe,
  type RecipeOp,
  isAskStep,
  isDoStep,
  isMessageStep,
} from './recipe.js';

export interface RecipePorts {
  readonly issues?: IssuesPort;
  readonly scm?: ScmPort;
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

function optLabels(params: Params, op: string): string[] | undefined {
  const value = params.labels;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((label) => typeof label !== 'string')) {
    throw new BaronError(`Step '${op}' 'labels' must be an array of strings.`, ARGS);
  }
  return value as string[];
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
        ...(optLabels(params, op) !== undefined ? { labels: optLabels(params, op) } : {}),
        ...(optStr(params, 'initialRole', op) !== undefined
          ? { initialRole: reqRole(params, 'initialRole', op) }
          : {}),
      });
    case RECIPE_OPS.issueTransition:
      return issues(ports, op).transition(reqStr(params, 'id', op), reqRole(params, 'role', op));
    case RECIPE_OPS.issueComment:
      return issues(ports, op).comment(reqStr(params, 'id', op), reqStr(params, 'body', op));
    case RECIPE_OPS.issueLink:
      return issues(ports, op).link(
        reqStr(params, 'fromId', op),
        reqStr(params, 'toId', op),
        reqLinkType(params, 'type', op),
      );
    case RECIPE_OPS.issueQuery: {
      const limit = optNum(params, 'limit', op);
      const query: IssueQuery = {
        ...(optStr(params, 'role', op) !== undefined ? { role: reqRole(params, 'role', op) } : {}),
        ...(optStr(params, 'typeRole', op) !== undefined
          ? { typeRole: reqTypeRole(params, 'typeRole', op) }
          : {}),
        ...(limit !== undefined ? { limit } : {}),
      };
      return issues(ports, op).query(query);
    }
    case RECIPE_OPS.scmBranchCreate:
      return scm(ports, op).createBranch({
        name: reqStr(params, 'name', op),
        fromBranch: reqStr(params, 'fromBranch', op),
      });
    case RECIPE_OPS.scmPrCreate:
      return scm(ports, op).createPullRequest({
        title: reqStr(params, 'title', op),
        sourceBranch: reqStr(params, 'sourceBranch', op),
        targetBranch: reqStr(params, 'targetBranch', op),
        ...(optStr(params, 'body', op) !== undefined ? { body: optStr(params, 'body', op) } : {}),
        ...(params.draft !== undefined ? { draft: params.draft === true } : {}),
      });
    case RECIPE_OPS.scmPrThread:
      return scm(ports, op).addPullRequestThread(
        reqStr(params, 'pullRequestId', op),
        reqStr(params, 'body', op),
      );
    default: {
      // Exhaustiveness guard: a new RecipeOp without a case lands here at compile time.
      const unreachable: never = op;
      throw new BaronError(`Unhandled recipe op '${String(unreachable)}'.`, 'RECIPE_OP');
    }
  }
}

/**
 * Execute a recipe step by step against the injected ports, threading a context: `ask` steps gather
 * typed human input (skipped when pre-seeded), `do` steps call a primitive and bind its result,
 * `message` steps surface a line. All workflow opinion lives in the recipe; this engine is pure
 * mechanism (invariant #3) and does no role/native translation (that stays in the ports, #4).
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

    if (isMessageStep(step)) {
      options.asker.note(String(interpolate(step.message, context)));
      continue;
    }

    if (isDoStep(step)) {
      const params = (interpolate(step.with ?? {}, context) ?? {}) as Params;
      const result = await dispatchOp(options.ports, step.do, params);
      if (step.as !== undefined) context[step.as] = result;
    }
  }

  return { context };
}
