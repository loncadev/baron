import {
  BaronError,
  type IssueDraft,
  type IssuesPort,
  WORKFLOW_ROLES,
  WORK_ITEM_TYPE_ROLES,
  type WorkflowRole,
  isWorkItemTypeRole,
  isWorkflowRole,
} from '@baron/core';

/** Tool names: snake_case, `baron_` (product) namespace, singular noun to mirror the primitives. */
export const MCP_TOOL_NAMES = {
  create: 'baron_issue_create',
  get: 'baron_issue_get',
  transition: 'baron_issue_transition',
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
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
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
    default:
      return run(() => {
        throw new BaronError(`Unknown tool '${name}'.`, 'UNKNOWN_TOOL');
      });
  }
}
