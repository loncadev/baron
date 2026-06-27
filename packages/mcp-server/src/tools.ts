import {
  BaronError,
  ISSUE_LINK_TYPES,
  type IssueDraft,
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

/** The ports the MCP server serves; each is present only if bound in policy.json. */
export interface McpPorts {
  readonly issues?: IssuesPort;
  readonly scm?: ScmPort;
}

/** Tool names: snake_case, `baron_` (product) namespace, singular noun to mirror the primitives. */
export const MCP_TOOL_NAMES = {
  create: 'baron_issue_create',
  get: 'baron_issue_get',
  transition: 'baron_issue_transition',
  comment: 'baron_issue_comment',
  link: 'baron_issue_link',
  query: 'baron_issue_query',
} as const;

export const SCM_TOOL_NAMES = {
  branchCreate: 'baron_scm_branch_create',
  prCreate: 'baron_scm_pr_create',
  prThread: 'baron_scm_pr_thread',
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
    name: MCP_TOOL_NAMES.query,
    description:
      'List issues filtered by workflow role and/or type role (filters are AND-combined).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        role: { type: 'string', enum: ROLE_ENUM, description: 'Filter by workflow role.' },
        typeRole: { type: 'string', enum: TYPE_ROLE_ENUM, description: 'Filter by type role.' },
        limit: { type: 'number', minimum: 1, description: 'Maximum number of issues to return.' },
      },
    },
  },
];

export const SCM_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: SCM_TOOL_NAMES.branchCreate,
    description: 'Create a branch from an existing base branch.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'fromBranch'],
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          description: 'New branch name (without refs/heads/).',
        },
        fromBranch: { type: 'string', minLength: 1, description: 'Existing branch to fork from.' },
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
      required: ['title', 'sourceBranch', 'targetBranch'],
      properties: {
        title: { type: 'string', minLength: 1 },
        body: { type: 'string' },
        sourceBranch: { type: 'string', minLength: 1 },
        targetBranch: { type: 'string', minLength: 1 },
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
  return {
    ...(roleRaw !== undefined ? { role: roleRaw as WorkflowRole } : {}),
    ...(typeRoleRaw !== undefined ? { typeRole: typeRoleRaw as WorkItemTypeRole } : {}),
    ...(limit !== undefined ? { limit: limit as number } : {}),
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
      return run(() =>
        port.createBranch({
          name: requireString(args, 'name'),
          fromBranch: requireString(args, 'fromBranch'),
        }),
      );
    case SCM_TOOL_NAMES.prCreate:
      return run(() => {
        const draft = optionalBoolean(args, 'draft');
        const body = optionalString(args, 'body');
        return port.createPullRequest({
          title: requireString(args, 'title'),
          sourceBranch: requireString(args, 'sourceBranch'),
          targetBranch: requireString(args, 'targetBranch'),
          ...(body !== undefined ? { body } : {}),
          ...(draft !== undefined ? { draft } : {}),
        });
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

/** The tool definitions advertised for the currently-bound ports. */
export function activeToolDefinitions(ports: McpPorts): ToolDefinition[] {
  return [...(ports.issues ? TOOL_DEFINITIONS : []), ...(ports.scm ? SCM_TOOL_DEFINITIONS : [])];
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
  return run(() => {
    throw new BaronError(`Unknown tool '${name}'.`, 'UNKNOWN_TOOL');
  });
}
