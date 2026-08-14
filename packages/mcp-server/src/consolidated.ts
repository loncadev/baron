import { BaronError } from '@lonca/baron-core';
import {
  CI_TOOL_NAMES,
  DEPLOY_TOOL_NAMES,
  LOOP_TOOL_NAMES,
  MCP_TOOL_NAMES,
  SCM_TOOL_NAMES,
  type ToolDefinition,
} from './names.js';

/**
 * The published tool surface: one tool per VERB, not per endpoint.
 *
 * Cursor caps a session at 40 tools in TOTAL. Publishing one tool per primitive spent 27 of that on
 * an issues+scm install and 36 with every port bound, so Baron alone consumed most of a user's budget
 * and could not be installed next to the provider MCP servers it exists to sit above — the opposite
 * of the point. Toolsets (#50) could not fix it: the shipped skills legitimately need provider
 * writes, so publishing fewer tools meant breaking them. Reducing the TOTAL is what was left.
 *
 * Each tool takes an `op` and routes to exactly the primitive that already existed. The primitives
 * and their validation are untouched — this is a surface, not a rewrite — which is also why it is
 * NOT a passthrough: every op is named, enumerated and typed, and there is no way to reach the
 * provider through here that Baron did not already model.
 */
export const TOOL_NAMES = {
  issueRead: 'baron_issue_read',
  issueWrite: 'baron_issue_write',
  issueMove: 'baron_issue_move',
  scmRead: 'baron_scm_read',
  scmWrite: 'baron_scm_write',
  ciRead: 'baron_ci_read',
  ciRun: 'baron_ci_run',
  deployRead: 'baron_deploy_read',
  notifySend: 'baron_notify_send',
  recipeList: 'baron_recipe_list',
  recipeRun: 'baron_recipe_run',
  nativeRequest: 'baron_native_request',
  memoryAppend: 'baron_memory_append',
  memoryQuery: 'baron_memory_query',
} as const;

/**
 * `op` -> the primitive it routes to. The primitive names are internal now: they name the dispatch
 * target, not a published tool, so the per-primitive handlers and their tests stay exactly as they
 * were and this table is the only thing that knows both vocabularies.
 */
export const OP_ROUTES: Record<string, Readonly<Record<string, string>>> = {
  [TOOL_NAMES.issueRead]: {
    get: MCP_TOOL_NAMES.get,
    query: MCP_TOOL_NAMES.query,
    iterations: MCP_TOOL_NAMES.iterations,
    classify: MCP_TOOL_NAMES.classify,
  },
  [TOOL_NAMES.issueWrite]: {
    create: MCP_TOOL_NAMES.create,
    update: MCP_TOOL_NAMES.update,
    comment: MCP_TOOL_NAMES.comment,
    assign: MCP_TOOL_NAMES.assign,
    link: MCP_TOOL_NAMES.link,
    set_iteration: MCP_TOOL_NAMES.setIteration,
  },
  // The semantic role layer stays its own tool: it is the thing Baron is FOR, and folding it into a
  // generic write would bury the one call an agent should reach for most.
  [TOOL_NAMES.issueMove]: {
    transition: MCP_TOOL_NAMES.transition,
    reconcile: MCP_TOOL_NAMES.reconcile,
    block: MCP_TOOL_NAMES.block,
    unblock: MCP_TOOL_NAMES.unblock,
  },
  [TOOL_NAMES.scmRead]: {
    pr_status: SCM_TOOL_NAMES.prStatus,
    pr_for_branch: SCM_TOOL_NAMES.prForBranch,
  },
  [TOOL_NAMES.scmWrite]: {
    branch_create: SCM_TOOL_NAMES.branchCreate,
    pr_create: SCM_TOOL_NAMES.prCreate,
    pr_thread: SCM_TOOL_NAMES.prThread,
    pr_ready: SCM_TOOL_NAMES.prReady,
    pr_merge: SCM_TOOL_NAMES.prMerge,
  },
  [TOOL_NAMES.ciRead]: {
    pipelines: CI_TOOL_NAMES.pipelines,
    runs: CI_TOOL_NAMES.runs,
    run_get: CI_TOOL_NAMES.runGet,
    run_logs: CI_TOOL_NAMES.runLogs,
  },
  [TOOL_NAMES.ciRun]: {
    trigger: CI_TOOL_NAMES.runTrigger,
    cancel: CI_TOOL_NAMES.runCancel,
  },
  [TOOL_NAMES.deployRead]: {
    environments: DEPLOY_TOOL_NAMES.environments,
    deployments: DEPLOY_TOOL_NAMES.deployments,
  },
  [TOOL_NAMES.memoryAppend]: {
    learning: LOOP_TOOL_NAMES.learningAppend,
    followup: LOOP_TOOL_NAMES.followupAppend,
  },
  [TOOL_NAMES.memoryQuery]: {
    learning: LOOP_TOOL_NAMES.learningQuery,
    followup: LOOP_TOOL_NAMES.followupList,
  },
};

const INVALID_ARGS = 'INVALID_ARGS';

/**
 * Turn a consolidated call into the primitive call it names. Rejects a missing or unknown `op` with
 * the ops that ARE available, because an agent that guessed wrong needs the list more than it needs
 * to be told it guessed.
 */
export function routeOp(
  name: string,
  args: Record<string, unknown> | undefined,
): { primitive: string; args: Record<string, unknown> | undefined } {
  const ops = OP_ROUTES[name];
  if (ops === undefined) return { primitive: name, args };

  const op = args?.op;
  if (typeof op !== 'string' || op.length === 0) {
    throw new BaronError(
      `'${name}' needs an 'op'. Available: ${Object.keys(ops).join(', ')}.`,
      INVALID_ARGS,
    );
  }
  const primitive = ops[op];
  if (primitive === undefined) {
    throw new BaronError(
      `'${name}' has no op '${op}'. Available: ${Object.keys(ops).join(', ')}.`,
      INVALID_ARGS,
    );
  }
  // `op` selected the primitive; it is not one of the primitive's own arguments.
  const { op: _selector, ...rest } = args ?? {};
  return { primitive, args: rest };
}

/** Every op a consolidated tool accepts, for its schema enum. */
function opsOf(name: string): string[] {
  return Object.keys(OP_ROUTES[name] ?? {});
}

/**
 * Merge the published properties of the primitives an op routes to. Every property except `op` is
 * optional here and validated by the primitive it reaches — which is where the per-op rules already
 * lived, so nothing is loosened that was previously enforced.
 */
function schemaOf(
  name: string,
  properties: Record<string, unknown>,
): ToolDefinition['inputSchema'] {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['op'],
    properties: {
      op: { type: 'string', enum: opsOf(name), description: 'Which operation to perform.' },
      ...properties,
    },
  };
}

const ID = { type: 'string', minLength: 1 } as const;

export const CONSOLIDATED_ISSUE_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: TOOL_NAMES.issueRead,
    mutatesProvider: false,
    description:
      'Read work items. ops: `get` (id) → one normalized issue; `query` (role / typeRole / ' +
      'assignee, `@me` allowed / iteration, `@current` allowed / limit) → a filtered list; ' +
      "`iterations` (no args) → the provider's sprints, each with a `current` flag, empty where the " +
      'provider has none.',
    inputSchema: schemaOf(TOOL_NAMES.issueRead, {
      id: ID,
      role: { type: 'string' },
      typeRole: { type: 'string' },
      assignee: { type: 'string' },
      iteration: { type: 'string' },
      limit: { type: 'integer', minimum: 1 },
    }),
  },
  {
    name: TOOL_NAMES.issueWrite,
    mutatesProvider: true,
    description:
      'Change a work item’s content. ops: `create` (title, typeRole, optional body/parentId/labels/' +
      'initialRole); `update` (id, title and/or body — a patch, omitted fields are left alone); ' +
      '`comment` (id, body); `assign` (id, assignee — `@me` allowed); `link` (fromId, toId, type); ' +
      '`set_iteration` (id, iteration — `@current` allowed). Roles and type roles are abstract: the ' +
      'active policy maps them to the provider’s own states and types.',
    inputSchema: schemaOf(TOOL_NAMES.issueWrite, {
      id: ID,
      title: { type: 'string', minLength: 1 },
      body: { type: 'string' },
      typeRole: { type: 'string' },
      parentId: { type: 'string' },
      labels: { type: 'array', items: { type: 'string' } },
      initialRole: { type: 'string' },
      assignee: { type: 'string' },
      fromId: { type: 'string' },
      toId: { type: 'string' },
      type: { type: 'string' },
      iteration: { type: 'string' },
    }),
  },
  {
    name: TOOL_NAMES.issueMove,
    mutatesProvider: true,
    description:
      'Move a work item through the workflow, or flag it. ops: `transition` (id, role) — the ' +
      'semantic role layer, resolving an abstract role to the provider’s native state/column/label; ' +
      '`reconcile` (id) — clear a role label the provider’s own state contradicts, commanding no ' +
      'role; `block` (id, reason — required) and `unblock` (id, optional reason), which set and clear ' +
      'an ORTHOGONAL flag and leave the role alone, so an item keeps the role it is blocked in.',
    inputSchema: schemaOf(TOOL_NAMES.issueMove, {
      id: ID,
      role: { type: 'string' },
      reason: { type: 'string' },
    }),
  },
];

export const CONSOLIDATED_SCM_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: TOOL_NAMES.scmRead,
    mutatesProvider: false,
    description:
      'Read source-control state. ops: `pr_status` (pullRequestId) → normalized state, review ' +
      'decision, mergeability and a checks rollup; `pr_for_branch` (sourceBranch, optional state — ' +
      '`open` default / `merged` / `closed` / `all`) → the most recent matching PR or null. `open` is ' +
      'the idempotency probe before creating one; `merged` is the drift probe.',
    inputSchema: schemaOf(TOOL_NAMES.scmRead, {
      pullRequestId: ID,
      sourceBranch: { type: 'string' },
      state: { type: 'string' },
    }),
  },
  {
    name: TOOL_NAMES.scmWrite,
    mutatesProvider: true,
    description:
      'Change source-control state. ops: `branch_create` (name, optional fromBranch — idempotent); ' +
      '`pr_create` (title, sourceBranch, optional targetBranch/body/draft/assignees/autoComplete, ' +
      'plus linkedIssueKey and linkedIssueRelation — `closes` finishes the item on merge, `relates` ' +
      'only references it); `pr_thread` (pullRequestId, body); `pr_ready` (pullRequestId) — take it out of ' +
      'draft; `pr_merge` (pullRequestId, optional strategy/deleteSourceBranch). A provider that ' +
      'declines a merge surfaces as MERGE_FAILED rather than a false success.',
    inputSchema: schemaOf(TOOL_NAMES.scmWrite, {
      name: { type: 'string' },
      fromBranch: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
      sourceBranch: { type: 'string' },
      targetBranch: { type: 'string' },
      draft: { type: 'boolean' },
      linkedIssueKey: { type: 'string' },
      linkedIssueRelation: { type: 'string' },
      assignees: { type: 'array', items: { type: 'string' } },
      autoComplete: { type: 'boolean' },
      pullRequestId: ID,
      strategy: { type: 'string' },
      deleteSourceBranch: { type: 'boolean' },
    }),
  },
];

export const CONSOLIDATED_CI_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: TOOL_NAMES.ciRead,
    mutatesProvider: false,
    description:
      'Read CI state. ops: `pipelines` (no args); `runs` (optional pipelineId/status/branch/limit, ' +
      'default 50) with a normalized status; `run_get` (id) including per-stage status; `run_logs` ' +
      '(runId, optional stageId/maxBytes) — a size-aware tail that reports whether it truncated.',
    inputSchema: schemaOf(TOOL_NAMES.ciRead, {
      id: ID,
      runId: { type: 'string' },
      pipelineId: { type: 'string' },
      status: { type: 'string' },
      branch: { type: 'string' },
      stageId: { type: 'string' },
      maxBytes: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1 },
    }),
  },
  {
    name: TOOL_NAMES.ciRun,
    mutatesProvider: true,
    description:
      'Start or stop CI work. ops: `trigger` (pipelineId, optional ref/variables); `cancel` (runId).',
    inputSchema: schemaOf(TOOL_NAMES.ciRun, {
      pipelineId: { type: 'string' },
      ref: { type: 'string' },
      variables: { type: 'object', additionalProperties: { type: 'string' } },
      runId: { type: 'string' },
    }),
  },
];

export const CONSOLIDATED_DEPLOY_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: TOOL_NAMES.deployRead,
    mutatesProvider: false,
    description:
      'Read deployment state. ops: `environments` (no args); `deployments` (optional environment/' +
      'limit) with a normalized status.',
    inputSchema: schemaOf(TOOL_NAMES.deployRead, {
      environment: { type: 'string' },
      limit: { type: 'integer', minimum: 1 },
    }),
  },
];

export const CONSOLIDATED_LOOP_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: TOOL_NAMES.memoryAppend,
    mutatesProvider: false,
    description:
      "Record something durable in Baron's own store (not a provider's). ops: `learning` (title, " +
      'body, optional tags) — a decision worth keeping; `followup` (title, optional body/tags) — an ' +
      'open loop to come back to.',
    inputSchema: schemaOf(TOOL_NAMES.memoryAppend, {
      title: { type: 'string', minLength: 1 },
      body: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
    }),
  },
  {
    name: TOOL_NAMES.memoryQuery,
    mutatesProvider: false,
    description:
      "Read Baron's own store. ops: `learning` (optional tag/text/limit); `followup` (optional " +
      'status/tag/limit).',
    inputSchema: schemaOf(TOOL_NAMES.memoryQuery, {
      tag: { type: 'string' },
      text: { type: 'string' },
      status: { type: 'string' },
      limit: { type: 'integer', minimum: 1 },
    }),
  },
];
