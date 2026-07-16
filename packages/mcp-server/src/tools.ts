import {
  BaronError,
  type CiPort,
  type DeployPort,
  ISSUE_LINK_TYPES,
  type IssueDraft,
  type IssueLinkType,
  type IssueQuery,
  type IssuesPort,
  type NotifyPort,
  PR_STATE_FILTERS,
  type PrStateFilter,
  RUN_STATUSES,
  type RunQuery,
  type RunStatus,
  type ScmPort,
  WORKFLOW_ROLES,
  WORK_ITEM_TYPE_ROLES,
  type WorkItemTypeRole,
  type WorkflowRole,
  isIssueLinkType,
  isPrStateFilter,
  isRunStatus,
  isWorkItemTypeRole,
  isWorkflowRole,
} from '@lonca/baron-core';
import {
  FOLLOWUP_STATUSES,
  type FollowupStatus,
  type KnowledgeLoop,
  isFollowupStatus,
} from '@lonca/baron-knowledge-loop';
import type { NativeRequest, NativeResponse } from '@lonca/baron-providers';
import type { RecipeService } from '@lonca/baron-recipes';

/** The provider-native escape hatch (decision #18), restricted by the caller to bound providers. */
export type NativeAccess = (provider: string, request: NativeRequest) => Promise<NativeResponse>;

/** The ports the MCP server serves. issues/scm bind from policy; knowledge is always available. */
export interface McpPorts {
  readonly issues?: IssuesPort;
  readonly scm?: ScmPort;
  readonly ci?: CiPort;
  readonly notify?: NotifyPort;
  readonly deploy?: DeployPort;
  readonly knowledge?: KnowledgeLoop;
  /** Provider-native escape hatch (decision #18); set by the loader, scoped to bound providers. */
  readonly nativeAccess?: NativeAccess;
  /** Deterministic recipe runner (built-ins + project recipes) over the bound ports. */
  readonly recipes?: RecipeService;
}

/** Tool names: snake_case, `baron_` (product) namespace, singular noun to mirror the primitives. */
export const MCP_TOOL_NAMES = {
  create: 'baron_issue_create',
  get: 'baron_issue_get',
  update: 'baron_issue_update',
  transition: 'baron_issue_transition',
  comment: 'baron_issue_comment',
  link: 'baron_issue_link',
  assign: 'baron_issue_assign',
  iterations: 'baron_issue_iterations',
  setIteration: 'baron_issue_set_iteration',
  query: 'baron_issue_query',
} as const;

export const SCM_TOOL_NAMES = {
  branchCreate: 'baron_scm_branch_create',
  prCreate: 'baron_scm_pr_create',
  prThread: 'baron_scm_pr_thread',
  prStatus: 'baron_scm_pr_status',
  prForBranch: 'baron_scm_pr_for_branch',
} as const;

export const CI_TOOL_NAMES = {
  pipelines: 'baron_ci_pipelines',
  runs: 'baron_ci_runs',
  runGet: 'baron_ci_run_get',
  runLogs: 'baron_ci_run_logs',
  runTrigger: 'baron_ci_run_trigger',
  runCancel: 'baron_ci_run_cancel',
} as const;

export const NOTIFY_TOOL_NAMES = {
  send: 'baron_notify_send',
} as const;

export const DEPLOY_TOOL_NAMES = {
  environments: 'baron_deploy_environments',
  deployments: 'baron_deploy_deployments',
} as const;

export const NATIVE_TOOL_NAMES = {
  request: 'baron_native_request',
} as const;

export const RECIPE_TOOL_NAMES = {
  list: 'baron_recipe_list',
  run: 'baron_recipe_run',
} as const;

export const LOOP_TOOL_NAMES = {
  learningAppend: 'baron_learning_append',
  learningQuery: 'baron_learning_query',
  followupAppend: 'baron_followup_append',
  followupList: 'baron_followup_list',
} as const;

/** A tool definition shaped for the MCP ListTools response (plain JSON Schema, no zod). */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, unknown>;
    readonly required?: readonly string[];
    readonly additionalProperties: false;
  };
}

/** The MCP text result shape (structurally a CallToolResult); kept SDK-agnostic for testability. */
export interface ToolResult {
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>;
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
}

// Enums are sourced from the core unions (single source of truth) so adding a role/type role in
// core auto-updates the tool surface — no hand-copied magic-string lists (invariant: no magic
// strings; #2: never expose provider-native states here).
const ROLE_ENUM = [...WORKFLOW_ROLES];
const TYPE_ROLE_ENUM = [...WORK_ITEM_TYPE_ROLES];
const LINK_TYPE_ENUM = [...ISSUE_LINK_TYPES];
const FOLLOWUP_STATUS_ENUM = [...FOLLOWUP_STATUSES];
const RUN_STATUS_ENUM = [...RUN_STATUSES];
const PR_STATE_FILTER_ENUM = [...PR_STATE_FILTERS];

/** Default cap for `baron_issue_query` so an unbounded listing can't overflow the agent's context. */
const DEFAULT_QUERY_LIMIT = 50;

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: MCP_TOOL_NAMES.create,
    description:
      'Create an issue from abstract terms. typeRole -> native work-item type and initialRole -> ' +
      'native state are translated automatically per the active policy; capability gaps (e.g. no ' +
      'native hierarchy) are handled by the configured gap policy.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'typeRole'],
      properties: {
        title: { type: 'string', minLength: 1 },
        typeRole: {
          type: 'string',
          enum: TYPE_ROLE_ENUM,
          description: 'Abstract type role; the provider maps it to a native work-item type.',
        },
        body: { type: 'string' },
        parentId: {
          type: 'string',
          description:
            'Parent issue id. On providers without native hierarchy this is emulated or degraded ' +
            'per the gap policy.',
        },
        labels: { type: 'array', items: { type: 'string' } },
        initialRole: {
          type: 'string',
          enum: ROLE_ENUM,
          description: 'Optional starting workflow role; omit to use the provider default.',
        },
      },
    },
  },
  {
    name: MCP_TOOL_NAMES.get,
    description: 'Fetch a normalized issue by id.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: { type: 'string', minLength: 1 } },
    },
  },
  {
    name: MCP_TOOL_NAMES.update,
    description:
      "Edit an existing issue's title and/or body. A patch: whatever you omit is left untouched. " +
      "The body goes to the field the item's type uses — a bug's body is its repro steps. Use this " +
      'to correct a title or fill in a description after creation; it does not change role or ' +
      'assignee (use baron_issue_transition / baron_issue_assign).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', minLength: 1 },
        title: { type: 'string', minLength: 1 },
        body: { type: 'string' },
      },
    },
  },
  {
    name: MCP_TOOL_NAMES.transition,
    description:
      'Transition an issue to a target workflow role (idempotent). The adapter resolves the role ' +
      'to the provider-native state/column/label.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'role'],
      properties: {
        id: { type: 'string', minLength: 1 },
        role: {
          type: 'string',
          enum: ROLE_ENUM,
          description: 'Target workflow role. Translated to the provider-native target.',
        },
      },
    },
  },
  {
    name: MCP_TOOL_NAMES.comment,
    description: 'Add a comment to an issue.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'body'],
      properties: {
        id: { type: 'string', minLength: 1 },
        body: { type: 'string', minLength: 1 },
      },
    },
  },
  {
    name: MCP_TOOL_NAMES.link,
    description:
      'Link two issues with an abstract relationship. On providers without native typed links the ' +
      'link is emulated or degraded per the gap policy.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['fromId', 'toId', 'type'],
      properties: {
        fromId: { type: 'string', minLength: 1 },
        toId: { type: 'string', minLength: 1 },
        type: {
          type: 'string',
          enum: LINK_TYPE_ENUM,
          description: 'Relationship from the source (fromId) to the target (toId) issue.',
        },
      },
    },
  },
  {
    name: MCP_TOOL_NAMES.assign,
    description:
      'Assign an issue to a user by their provider-native handle (Azure DevOps: email; GitHub: ' +
      'login). Providers without assignment negotiate the gap per policy.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'assignee'],
      properties: {
        id: { type: 'string', minLength: 1 },
        assignee: {
          type: 'string',
          minLength: 1,
          description: 'Provider-native user handle (email on Azure DevOps, login on GitHub).',
        },
      },
    },
  },
  {
    name: MCP_TOOL_NAMES.iterations,
    description:
      "List the provider's iterations/sprints (each with a `current` flag). Empty when the provider " +
      'has no sprints. Use it to find the active sprint or a target for set_iteration.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: MCP_TOOL_NAMES.setIteration,
    description:
      "Move a work item to an iteration/sprint by path, or '@current' for the active sprint. " +
      'Providers without sprints negotiate the gap per policy.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'iteration'],
      properties: {
        id: { type: 'string', minLength: 1 },
        iteration: {
          type: 'string',
          minLength: 1,
          description: "Iteration path (from iterations) or '@current' for the active sprint.",
        },
      },
    },
  },
  {
    name: MCP_TOOL_NAMES.query,
    description:
      'List issues filtered by workflow role and/or type role (filters are AND-combined). Returns a ' +
      'lightweight projection (no body); fetch an issue with get for full detail.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        role: { type: 'string', enum: ROLE_ENUM, description: 'Filter by workflow role.' },
        typeRole: { type: 'string', enum: TYPE_ROLE_ENUM, description: 'Filter by type role.' },
        assignee: {
          type: 'string',
          minLength: 1,
          description:
            "Filter by assignee: a provider-native handle (Azure: email; GitHub: login) or '@me' " +
            'for the authenticated user.',
        },
        iteration: {
          type: 'string',
          minLength: 1,
          description: "Filter by iteration path, or '@current' for the active sprint.",
        },
        limit: {
          type: 'number',
          minimum: 1,
          description: `Maximum number of issues to return. Defaults to ${DEFAULT_QUERY_LIMIT} to keep the result within an agent's context; pass a higher value for more.`,
        },
      },
    },
  },
];

export const SCM_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: SCM_TOOL_NAMES.branchCreate,
    description: 'Create a branch from a base branch (defaults to the repository default branch).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          description: 'New branch name (without refs/heads/).',
        },
        fromBranch: {
          type: 'string',
          minLength: 1,
          description: "Branch to fork from. Defaults to the repository's default branch.",
        },
      },
    },
  },
  {
    name: SCM_TOOL_NAMES.prCreate,
    description:
      'Open a pull request. A requested draft may be degraded to a ready PR if the provider lacks ' +
      'draft support (per the gap policy); the returned `draft` reflects what was actually opened.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'sourceBranch'],
      properties: {
        title: { type: 'string', minLength: 1 },
        body: { type: 'string' },
        sourceBranch: { type: 'string', minLength: 1 },
        targetBranch: {
          type: 'string',
          minLength: 1,
          description: "Branch to merge into. Defaults to the repository's default branch.",
        },
        draft: { type: 'boolean', description: 'Open as a draft PR when supported.' },
      },
    },
  },
  {
    name: SCM_TOOL_NAMES.prThread,
    description: 'Add a discussion thread/comment to a pull request.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['pullRequestId', 'body'],
      properties: {
        pullRequestId: { type: 'string', minLength: 1 },
        body: { type: 'string', minLength: 1 },
      },
    },
  },
  {
    name: SCM_TOOL_NAMES.prStatus,
    description:
      "Read a pull request's normalized status: state, review decision, mergeability, and a checks " +
      'rollup — the "is it ready to merge?" view.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['pullRequestId'],
      properties: { pullRequestId: { type: 'string', minLength: 1 } },
    },
  },
  {
    name: SCM_TOOL_NAMES.prForBranch,
    description:
      'Find the most recent pull request for a branch matching `state` (null when none), with its ' +
      "normalized `state`. `open` (default) = the finish-flow idempotency probe (don't duplicate an " +
      'open PR); `merged` = the drift probe (did this branch land while its item stayed in progress?).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sourceBranch'],
      properties: {
        sourceBranch: {
          type: 'string',
          minLength: 1,
          description: 'Branch name (no refs/heads/).',
        },
        state: {
          type: 'string',
          enum: PR_STATE_FILTER_ENUM,
          description: "Lifecycle to search: 'open' (default), 'merged', 'closed', or 'all'.",
        },
      },
    },
  },
];

export const CI_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: CI_TOOL_NAMES.pipelines,
    description: 'List pipeline definitions.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: {
          type: 'number',
          minimum: 1,
          description: 'Maximum number of pipelines to return.',
        },
      },
    },
  },
  {
    name: CI_TOOL_NAMES.runs,
    description:
      'List CI runs (filter by pipeline / branch / normalized status). Returns a lightweight ' +
      'projection; status is the provider-agnostic run status.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pipelineId: { type: 'string', minLength: 1, description: 'Restrict to one pipeline.' },
        branch: { type: 'string', minLength: 1, description: 'Restrict to a source branch.' },
        status: {
          type: 'string',
          enum: RUN_STATUS_ENUM,
          description: 'Filter by normalized run status.',
        },
        limit: {
          type: 'number',
          minimum: 1,
          description: `Maximum number of runs to return. Defaults to ${DEFAULT_QUERY_LIMIT} to keep the result within an agent's context.`,
        },
      },
    },
  },
  {
    name: CI_TOOL_NAMES.runGet,
    description: 'Get one run, including its stages when the provider surfaces them.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: { type: 'string', minLength: 1 } },
    },
  },
  {
    name: CI_TOOL_NAMES.runLogs,
    description:
      "Fetch a run's logs. Size-aware: returns a lean tail by default (`truncated` flags omitted " +
      'content); raise `tailLines` for more.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['runId'],
      properties: {
        runId: { type: 'string', minLength: 1 },
        tailLines: {
          type: 'number',
          minimum: 1,
          description: 'Max lines to return from the tail.',
        },
      },
    },
  },
  {
    name: CI_TOOL_NAMES.runTrigger,
    description:
      'Queue a new run of a pipeline. Returns { accepted, run? } — `run` is present only when the ' +
      'provider returns it synchronously (some providers dispatch asynchronously with no run id).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['pipelineId'],
      properties: {
        pipelineId: { type: 'string', minLength: 1 },
        ref: {
          type: 'string',
          minLength: 1,
          description: "Branch/tag to run on. Defaults to the repository's default branch.",
        },
        variables: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Pipeline variables / workflow inputs.',
        },
      },
    },
  },
  {
    name: CI_TOOL_NAMES.runCancel,
    description: 'Cancel a run; returns the run with its updated status.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['runId'],
      properties: { runId: { type: 'string', minLength: 1 } },
    },
  },
];

export const NOTIFY_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: NOTIFY_TOOL_NAMES.send,
    description:
      'Send a notification. Targeting a channel or threading a reply may be degraded/errored per the ' +
      'gap policy on providers that lack those capabilities.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', minLength: 1 },
        channel: {
          type: 'string',
          minLength: 1,
          description: 'Target channel (requires channels).',
        },
        threadKey: {
          type: 'string',
          minLength: 1,
          description: 'Thread to reply under (an opaque key from a prior send; requires threads).',
        },
      },
    },
  },
];

export const DEPLOY_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: DEPLOY_TOOL_NAMES.environments,
    description: 'List deployment environments (e.g. dev / staging / prod).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', minimum: 1, description: 'Maximum number to return.' },
      },
    },
  },
  {
    name: DEPLOY_TOOL_NAMES.deployments,
    description:
      'List recent deployments with a normalized status (optionally filtered to one environment).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        environment: { type: 'string', minLength: 1, description: 'Restrict to one environment.' },
        limit: { type: 'number', minimum: 1, description: 'Maximum number to return.' },
      },
    },
  },
];

export const NATIVE_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: NATIVE_TOOL_NAMES.request,
    description:
      'ESCAPE HATCH — a raw, authenticated, NON-PORTABLE provider REST call. Last resort for when no ' +
      'normalized tool (issue/scm/ci/notify) covers the need. You supply the provider-native ' +
      'method + path (+ query/body); Baron only attaches the base URL + auth and returns the ' +
      '(size-capped) response. Prefer the normalized tools — this is provider-specific and will not ' +
      'port to another provider. Only providers bound in the active policy are reachable.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['provider', 'method', 'path'],
      properties: {
        provider: { type: 'string', minLength: 1, description: 'A provider bound in the policy.' },
        method: { type: 'string', minLength: 1, description: 'HTTP method (GET/POST/PATCH/…).' },
        path: {
          type: 'string',
          minLength: 1,
          description: 'Provider-relative path, including any required api-version query.',
        },
        query: { type: 'object', additionalProperties: { type: 'string' } },
        body: { description: 'JSON request body (any shape).' },
      },
    },
  },
];

export const RECIPE_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: RECIPE_TOOL_NAMES.list,
    description:
      'List the runnable recipes (built-ins + project recipes) with their declared inputs. Call this ' +
      'to discover what `baron_recipe_run` accepts before running a workflow.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: RECIPE_TOOL_NAMES.run,
    description:
      'Run a named recipe end-to-end as ONE deterministic, rule-enforced workflow (the engine — not ' +
      'you — enforces the step order). Supply all required inputs (from baron_recipe_list) in ' +
      '`inputs`; a missing required input errors rather than prompting. Prefer this over composing the ' +
      'individual issue/scm/ci tools yourself for a packaged workflow.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1, description: 'Recipe name (e.g. task-start).' },
        inputs: {
          type: 'object',
          description: "Values for the recipe's `ask` inputs, keyed by input name.",
        },
      },
    },
  },
];

export const LOOP_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: LOOP_TOOL_NAMES.learningAppend,
    description: 'Record a durable learning (knowledge that should survive across runs).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'body'],
      properties: {
        title: { type: 'string', minLength: 1 },
        body: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: LOOP_TOOL_NAMES.learningQuery,
    description: 'Query recorded learnings by tag and/or free text (newest first).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tag: { type: 'string' },
        text: { type: 'string', description: 'Case-insensitive substring over title + body.' },
        limit: { type: 'number', minimum: 1 },
      },
    },
  },
  {
    name: LOOP_TOOL_NAMES.followupAppend,
    description: 'Record an open follow-up (deferred work to revisit later).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['title'],
      properties: {
        title: { type: 'string', minLength: 1 },
        body: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: LOOP_TOOL_NAMES.followupList,
    description: 'List follow-ups by status and/or tag (newest first).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: FOLLOWUP_STATUS_ENUM },
        tag: { type: 'string' },
        limit: { type: 'number', minimum: 1 },
      },
    },
  },
];

const INVALID_ARGS = 'INVALID_ARGS';

function requireString(args: Record<string, unknown> | undefined, key: string): string {
  const value = args?.[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new BaronError(`Missing or empty required string argument '${key}'.`, INVALID_ARGS);
  }
  return value;
}

function optionalString(
  args: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = args?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new BaronError(`Argument '${key}' must be a string.`, INVALID_ARGS);
  }
  return value;
}

function optionalLabels(args: Record<string, unknown> | undefined): string[] | undefined {
  const value = args?.labels;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((label) => typeof label !== 'string')) {
    throw new BaronError("Argument 'labels' must be an array of strings.", INVALID_ARGS);
  }
  return value as string[];
}

function requireRole(args: Record<string, unknown> | undefined): WorkflowRole {
  const value = requireString(args, 'role');
  if (!isWorkflowRole(value)) {
    throw new BaronError(
      `Invalid role '${value}'. Expected one of: ${WORKFLOW_ROLES.join(', ')}.`,
      INVALID_ARGS,
    );
  }
  return value;
}

function requireLinkType(args: Record<string, unknown> | undefined): IssueLinkType {
  const value = requireString(args, 'type');
  if (!isIssueLinkType(value)) {
    throw new BaronError(
      `Invalid link type '${value}'. Expected one of: ${ISSUE_LINK_TYPES.join(', ')}.`,
      INVALID_ARGS,
    );
  }
  return value;
}

function toQuery(args: Record<string, unknown> | undefined): IssueQuery {
  const roleRaw = optionalString(args, 'role');
  if (roleRaw !== undefined && !isWorkflowRole(roleRaw)) {
    throw new BaronError(
      `Invalid role '${roleRaw}'. Expected one of: ${WORKFLOW_ROLES.join(', ')}.`,
      INVALID_ARGS,
    );
  }
  const typeRoleRaw = optionalString(args, 'typeRole');
  if (typeRoleRaw !== undefined && !isWorkItemTypeRole(typeRoleRaw)) {
    throw new BaronError(
      `Invalid typeRole '${typeRoleRaw}'. Expected one of: ${WORK_ITEM_TYPE_ROLES.join(', ')}.`,
      INVALID_ARGS,
    );
  }
  const limit = args?.limit;
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1)) {
    throw new BaronError("Argument 'limit' must be a positive number.", INVALID_ARGS);
  }
  const assignee = optionalString(args, 'assignee');
  const iteration = optionalString(args, 'iteration');
  // Default the cap so an unbounded query (e.g. an early-project backlog spanning hundreds of items)
  // can't overflow the agent's context. The default is documented in the tool schema, not silent.
  return {
    ...(roleRaw !== undefined ? { role: roleRaw as WorkflowRole } : {}),
    ...(typeRoleRaw !== undefined ? { typeRole: typeRoleRaw as WorkItemTypeRole } : {}),
    ...(assignee !== undefined ? { assignee } : {}),
    ...(iteration !== undefined ? { iteration } : {}),
    limit: limit !== undefined ? (limit as number) : DEFAULT_QUERY_LIMIT,
  };
}

function toDraft(args: Record<string, unknown> | undefined): IssueDraft {
  const title = requireString(args, 'title');
  const typeRole = requireString(args, 'typeRole');
  if (!isWorkItemTypeRole(typeRole)) {
    throw new BaronError(
      `Invalid typeRole '${typeRole}'. Expected one of: ${WORK_ITEM_TYPE_ROLES.join(', ')}.`,
      INVALID_ARGS,
    );
  }
  const body = optionalString(args, 'body');
  const parentId = optionalString(args, 'parentId');
  const labels = optionalLabels(args);
  const initialRoleRaw = optionalString(args, 'initialRole');
  if (initialRoleRaw !== undefined && !isWorkflowRole(initialRoleRaw)) {
    throw new BaronError(
      `Invalid initialRole '${initialRoleRaw}'. Expected one of: ${WORKFLOW_ROLES.join(', ')}.`,
      INVALID_ARGS,
    );
  }
  return {
    title,
    typeRole,
    ...(body !== undefined ? { body } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
    ...(labels !== undefined ? { labels } : {}),
    ...(initialRoleRaw !== undefined ? { initialRole: initialRoleRaw } : {}),
  };
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const result = await fn();
    // A void primitive (link) has no payload; report a stable success object rather than `undefined`,
    // which JSON.stringify would drop (leaving an invalid non-string text block).
    const text = result === undefined ? '{"ok":true}' : JSON.stringify(result);
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    // BaronError carries an actionable, branchable code; surface it as an isError result (not a
    // protocol error) so the agent sees the gap and can self-correct (invariant #5: never silent).
    // The code also rides in structuredContent so the agent can branch without parsing prose.
    if (error instanceof BaronError) {
      return {
        isError: true,
        content: [{ type: 'text', text: `${error.code}: ${error.message}` }],
        structuredContent: { code: error.code, message: error.message },
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [{ type: 'text', text: `INTERNAL: ${message}` }],
      structuredContent: { code: 'INTERNAL', message },
    };
  }
}

/**
 * Dispatch an MCP tool call to the issues port. Marshals arguments and shapes errors only — it does
 * no role/state translation (invariant #4) and holds no workflow opinion (invariant #3). Unknown
 * tool names and bad arguments surface as isError results so the agent always sees them.
 */
export function callTool(
  port: IssuesPort,
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<ToolResult> {
  switch (name) {
    case MCP_TOOL_NAMES.create:
      return run(() => port.create(toDraft(args)));
    case MCP_TOOL_NAMES.get:
      return run(() => port.get(requireString(args, 'id')));
    case MCP_TOOL_NAMES.update: {
      const title = optionalString(args, 'title');
      const body = optionalString(args, 'body');
      return run(() =>
        port.update(requireString(args, 'id'), {
          ...(title !== undefined ? { title } : {}),
          ...(body !== undefined ? { body } : {}),
        }),
      );
    }
    case MCP_TOOL_NAMES.transition:
      return run(() => port.transition(requireString(args, 'id'), requireRole(args)));
    case MCP_TOOL_NAMES.comment:
      return run(() => port.comment(requireString(args, 'id'), requireString(args, 'body')));
    case MCP_TOOL_NAMES.link:
      return run(() =>
        port.link(
          requireString(args, 'fromId'),
          requireString(args, 'toId'),
          requireLinkType(args),
        ),
      );
    case MCP_TOOL_NAMES.assign:
      return run(() => port.assign(requireString(args, 'id'), requireString(args, 'assignee')));
    case MCP_TOOL_NAMES.iterations:
      return run(() => port.iterations());
    case MCP_TOOL_NAMES.setIteration:
      return run(() =>
        port.setIteration(requireString(args, 'id'), requireString(args, 'iteration')),
      );
    case MCP_TOOL_NAMES.query:
      return run(() => port.query(toQuery(args)));
    default:
      return run(() => {
        throw new BaronError(`Unknown tool '${name}'.`, 'UNKNOWN_TOOL');
      });
  }
}

function optionalBoolean(
  args: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = args?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new BaronError(`Argument '${key}' must be a boolean.`, INVALID_ARGS);
  }
  return value;
}

/** Dispatch an scm tool call to the scm port (marshalling + error shaping only). */
export function callScmTool(
  port: ScmPort,
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<ToolResult> {
  switch (name) {
    case SCM_TOOL_NAMES.branchCreate:
      return run(() => {
        const fromBranch = optionalString(args, 'fromBranch');
        return port.createBranch({
          name: requireString(args, 'name'),
          ...(fromBranch !== undefined ? { fromBranch } : {}),
        });
      });
    case SCM_TOOL_NAMES.prCreate:
      return run(() => {
        const draft = optionalBoolean(args, 'draft');
        const body = optionalString(args, 'body');
        const targetBranch = optionalString(args, 'targetBranch');
        return port.createPullRequest({
          title: requireString(args, 'title'),
          sourceBranch: requireString(args, 'sourceBranch'),
          ...(targetBranch !== undefined ? { targetBranch } : {}),
          ...(body !== undefined ? { body } : {}),
          ...(draft !== undefined ? { draft } : {}),
        });
      });
    case SCM_TOOL_NAMES.prStatus:
      return run(() => port.prStatus(requireString(args, 'pullRequestId')));
    case SCM_TOOL_NAMES.prForBranch:
      return run(async () => {
        const stateRaw = optionalString(args, 'state');
        if (stateRaw !== undefined && !isPrStateFilter(stateRaw)) {
          throw new BaronError(
            `Invalid state '${stateRaw}'. Expected one of: ${PR_STATE_FILTERS.join(', ')}.`,
            INVALID_ARGS,
          );
        }
        // Map "no PR" to an explicit null: run() reports undefined as {"ok":true}, which would
        // read as success-with-a-PR; null tells the agent unambiguously "none matches".
        const pr = await port.prForBranch(
          requireString(args, 'sourceBranch'),
          stateRaw as PrStateFilter | undefined,
        );
        return pr ?? null;
      });
    case SCM_TOOL_NAMES.prThread:
      return run(() =>
        port.addPullRequestThread(
          requireString(args, 'pullRequestId'),
          requireString(args, 'body'),
        ),
      );
    default:
      return run(() => {
        throw new BaronError(`Unknown tool '${name}'.`, 'UNKNOWN_TOOL');
      });
  }
}

function optStringArray(
  args: Record<string, unknown> | undefined,
  key: string,
): string[] | undefined {
  const value = args?.[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new BaronError(`Argument '${key}' must be an array of strings.`, INVALID_ARGS);
  }
  return value as string[];
}

function optNumber(args: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = args?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BaronError(`Argument '${key}' must be a number.`, INVALID_ARGS);
  }
  return value;
}

function optFollowupStatus(args: Record<string, unknown> | undefined): FollowupStatus | undefined {
  const value = optionalString(args, 'status');
  if (value === undefined) return undefined;
  if (!isFollowupStatus(value)) {
    throw new BaronError(
      `Invalid status '${value}'. Expected one of: ${FOLLOWUP_STATUSES.join(', ')}.`,
      INVALID_ARGS,
    );
  }
  return value;
}

/** Dispatch a knowledge-loop tool call (marshalling + error shaping only). */
export function callLoopTool(
  loop: KnowledgeLoop,
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<ToolResult> {
  switch (name) {
    case LOOP_TOOL_NAMES.learningAppend:
      return run(() => {
        const tags = optStringArray(args, 'tags');
        return loop.learningAppend({
          title: requireString(args, 'title'),
          body: requireString(args, 'body'),
          ...(tags !== undefined ? { tags } : {}),
        });
      });
    case LOOP_TOOL_NAMES.learningQuery:
      return run(() => {
        const tag = optionalString(args, 'tag');
        const text = optionalString(args, 'text');
        const limit = optNumber(args, 'limit');
        return loop.learningQuery({
          ...(tag !== undefined ? { tag } : {}),
          ...(text !== undefined ? { text } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
      });
    case LOOP_TOOL_NAMES.followupAppend:
      return run(() => {
        const body = optionalString(args, 'body');
        const tags = optStringArray(args, 'tags');
        return loop.followupAppend({
          title: requireString(args, 'title'),
          ...(body !== undefined ? { body } : {}),
          ...(tags !== undefined ? { tags } : {}),
        });
      });
    case LOOP_TOOL_NAMES.followupList:
      return run(() => {
        const status = optFollowupStatus(args);
        const tag = optionalString(args, 'tag');
        const limit = optNumber(args, 'limit');
        return loop.followupList({
          ...(status !== undefined ? { status } : {}),
          ...(tag !== undefined ? { tag } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
      });
    default:
      return run(() => {
        throw new BaronError(`Unknown tool '${name}'.`, 'UNKNOWN_TOOL');
      });
  }
}

function toRunQuery(args: Record<string, unknown> | undefined): RunQuery {
  const pipelineId = optionalString(args, 'pipelineId');
  const branch = optionalString(args, 'branch');
  const statusRaw = optionalString(args, 'status');
  if (statusRaw !== undefined && !isRunStatus(statusRaw)) {
    throw new BaronError(
      `Invalid status '${statusRaw}'. Expected one of: ${RUN_STATUSES.join(', ')}.`,
      INVALID_ARGS,
    );
  }
  const limit = args?.limit;
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1)) {
    throw new BaronError("Argument 'limit' must be a positive number.", INVALID_ARGS);
  }
  return {
    ...(pipelineId !== undefined ? { pipelineId } : {}),
    ...(branch !== undefined ? { branch } : {}),
    ...(statusRaw !== undefined ? { status: statusRaw as RunStatus } : {}),
    limit: limit !== undefined ? (limit as number) : DEFAULT_QUERY_LIMIT,
  };
}

function optionalStringRecord(
  args: Record<string, unknown> | undefined,
  key: string,
): Record<string, string> | undefined {
  const value = args?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BaronError(`Argument '${key}' must be an object of string values.`, INVALID_ARGS);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') {
      throw new BaronError(`Argument '${key}.${k}' must be a string.`, INVALID_ARGS);
    }
    out[k] = v;
  }
  return out;
}

/** Dispatch an MCP tool call to the ci port. Marshals + shapes errors only. */
export function callCiTool(
  port: CiPort,
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<ToolResult> {
  switch (name) {
    case CI_TOOL_NAMES.pipelines:
      return run(() => {
        const limit = optNumber(args, 'limit');
        return port.pipelines(limit !== undefined ? { limit } : {});
      });
    case CI_TOOL_NAMES.runs:
      return run(() => port.runs(toRunQuery(args)));
    case CI_TOOL_NAMES.runGet:
      return run(() => port.run(requireString(args, 'id')));
    case CI_TOOL_NAMES.runLogs:
      return run(() => {
        const tailLines = optNumber(args, 'tailLines');
        return port.logs(
          requireString(args, 'runId'),
          tailLines !== undefined ? { tailLines } : {},
        );
      });
    case CI_TOOL_NAMES.runTrigger:
      return run(() => {
        const ref = optionalString(args, 'ref');
        const variables = optionalStringRecord(args, 'variables');
        return port.trigger({
          pipelineId: requireString(args, 'pipelineId'),
          ...(ref !== undefined ? { ref } : {}),
          ...(variables !== undefined ? { variables } : {}),
        });
      });
    case CI_TOOL_NAMES.runCancel:
      return run(() => port.cancel(requireString(args, 'runId')));
    default:
      return run(() => {
        throw new BaronError(`Unknown tool '${name}'.`, 'UNKNOWN_TOOL');
      });
  }
}

/** Dispatch an MCP tool call to the notify port. Marshals + shapes errors only. */
export function callNotifyTool(
  port: NotifyPort,
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<ToolResult> {
  switch (name) {
    case NOTIFY_TOOL_NAMES.send:
      return run(() => {
        const channel = optionalString(args, 'channel');
        const threadKey = optionalString(args, 'threadKey');
        return port.send({
          text: requireString(args, 'text'),
          ...(channel !== undefined ? { channel } : {}),
          ...(threadKey !== undefined ? { threadKey } : {}),
        });
      });
    default:
      return run(() => {
        throw new BaronError(`Unknown tool '${name}'.`, 'UNKNOWN_TOOL');
      });
  }
}

/** Dispatch an MCP tool call to the deploy port. Marshals + shapes errors only. */
export function callDeployTool(
  port: DeployPort,
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<ToolResult> {
  switch (name) {
    case DEPLOY_TOOL_NAMES.environments:
      return run(() => {
        const limit = optNumber(args, 'limit');
        return port.environments(limit !== undefined ? { limit } : {});
      });
    case DEPLOY_TOOL_NAMES.deployments:
      return run(() => {
        const environment = optionalString(args, 'environment');
        const limit = optNumber(args, 'limit');
        return port.deployments({
          ...(environment !== undefined ? { environment } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
      });
    default:
      return run(() => {
        throw new BaronError(`Unknown tool '${name}'.`, 'UNKNOWN_TOOL');
      });
  }
}

/** Dispatch an MCP tool call to the recipe runner. Marshals + shapes errors only. */
export function callRecipeTool(
  service: RecipeService,
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<ToolResult> {
  switch (name) {
    case RECIPE_TOOL_NAMES.list:
      return run(async () => service.list());
    case RECIPE_TOOL_NAMES.run:
      return run(() => {
        const inputs = args?.inputs;
        if (
          inputs !== undefined &&
          (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs))
        ) {
          throw new BaronError("Argument 'inputs' must be an object.", INVALID_ARGS);
        }
        return service.run(
          requireString(args, 'name'),
          (inputs as Record<string, unknown> | undefined) ?? {},
        );
      });
    default:
      return run(() => {
        throw new BaronError(`Unknown tool '${name}'.`, 'UNKNOWN_TOOL');
      });
  }
}

/** Dispatch the escape-hatch tool to the native access fn. Marshals + shapes errors only. */
export function callNativeTool(
  access: NativeAccess,
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<ToolResult> {
  switch (name) {
    case NATIVE_TOOL_NAMES.request:
      return run(() => {
        const query = optionalStringRecord(args, 'query');
        const body = args?.body;
        return access(requireString(args, 'provider'), {
          method: requireString(args, 'method'),
          path: requireString(args, 'path'),
          ...(query !== undefined ? { query } : {}),
          ...(body !== undefined ? { body } : {}),
        });
      });
    default:
      return run(() => {
        throw new BaronError(`Unknown tool '${name}'.`, 'UNKNOWN_TOOL');
      });
  }
}

/** The tool definitions advertised for the currently-bound ports. */
export function activeToolDefinitions(ports: McpPorts): ToolDefinition[] {
  return [
    ...(ports.issues ? TOOL_DEFINITIONS : []),
    ...(ports.scm ? SCM_TOOL_DEFINITIONS : []),
    ...(ports.ci ? CI_TOOL_DEFINITIONS : []),
    ...(ports.notify ? NOTIFY_TOOL_DEFINITIONS : []),
    ...(ports.deploy ? DEPLOY_TOOL_DEFINITIONS : []),
    ...(ports.recipes ? RECIPE_TOOL_DEFINITIONS : []),
    ...(ports.nativeAccess ? NATIVE_TOOL_DEFINITIONS : []),
    ...(ports.knowledge ? LOOP_TOOL_DEFINITIONS : []),
  ];
}

/** Route a tool call to the right port by its name prefix; unbound ports / unknown names error. */
export function dispatchTool(
  ports: McpPorts,
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<ToolResult> {
  if (name.startsWith('baron_issue_')) {
    if (ports.issues === undefined) {
      return run(() => {
        throw new BaronError('The issues port is not configured.', 'PORT_UNBOUND');
      });
    }
    return callTool(ports.issues, name, args);
  }
  if (name.startsWith('baron_scm_')) {
    if (ports.scm === undefined) {
      return run(() => {
        throw new BaronError('The scm port is not configured.', 'PORT_UNBOUND');
      });
    }
    return callScmTool(ports.scm, name, args);
  }
  if (name.startsWith('baron_ci_')) {
    if (ports.ci === undefined) {
      return run(() => {
        throw new BaronError('The ci port is not configured.', 'PORT_UNBOUND');
      });
    }
    return callCiTool(ports.ci, name, args);
  }
  if (name.startsWith('baron_notify_')) {
    if (ports.notify === undefined) {
      return run(() => {
        throw new BaronError('The notify port is not configured.', 'PORT_UNBOUND');
      });
    }
    return callNotifyTool(ports.notify, name, args);
  }
  if (name.startsWith('baron_deploy_')) {
    if (ports.deploy === undefined) {
      return run(() => {
        throw new BaronError('The deploy port is not configured.', 'PORT_UNBOUND');
      });
    }
    return callDeployTool(ports.deploy, name, args);
  }
  if (name.startsWith('baron_recipe_')) {
    if (ports.recipes === undefined) {
      return run(() => {
        throw new BaronError('The recipe runner is not available.', 'PORT_UNBOUND');
      });
    }
    return callRecipeTool(ports.recipes, name, args);
  }
  if (name.startsWith('baron_native_')) {
    if (ports.nativeAccess === undefined) {
      return run(() => {
        throw new BaronError('The provider-native escape hatch is not available.', 'PORT_UNBOUND');
      });
    }
    return callNativeTool(ports.nativeAccess, name, args);
  }
  if (name.startsWith('baron_learning_') || name.startsWith('baron_followup_')) {
    if (ports.knowledge === undefined) {
      return run(() => {
        throw new BaronError('The knowledge loop is not configured.', 'PORT_UNBOUND');
      });
    }
    return callLoopTool(ports.knowledge, name, args);
  }
  return run(() => {
    throw new BaronError(`Unknown tool '${name}'.`, 'UNKNOWN_TOOL');
  });
}
