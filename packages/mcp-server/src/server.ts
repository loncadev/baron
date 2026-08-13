import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { type McpPorts, type ToolResult, activeToolDefinitions, dispatchTool } from './tools.js';
import { startUpdateCheck } from './update-check.js';
import { OWN_PACKAGE } from './version.js';

export const SERVER_INFO = { name: 'baron', version: OWN_PACKAGE.version } as const;

/**
 * Sent on initialize and, in harnesses that defer tool definitions until they are needed (Claude
 * Code's tool search is on by default), this is the ONLY description of the server the model sees
 * up front — so it has to convey the role vocabulary and the recipes-over-primitives preference
 * without listing tools. Clients truncate instructions along with tool descriptions at ~2KB; keep
 * this well under that and let the tool schemas carry the detail.
 */
export const SERVER_INSTRUCTIONS = `Baron normalizes work tracking and delivery across providers (Azure DevOps, GitHub, Slack) behind one contract, so the same calls work whatever the stack.

Speak in ROLES, never a vendor's native states: backlog, ready, in_progress, in_review, done. Blocking is ORTHOGONAL, not a role: use baron_issue_block (id + a required reason) and baron_issue_unblock — a blocked item keeps the role it is blocked in, so unblocking returns it to where the work actually was. Item types are roles too: initiative, epic, story, task, bug, subtask. Baron maps a role to the provider's real state, column or label using a mapping the human confirmed at \`baron init\` — do not guess native state names, and do not try to set them directly.

Prefer \`baron_recipe_run\` over hand-composing primitives. Recipes (task-new, task-start, task-finish, task-land, ship) run a whole workflow in one call with guards that stop before mutating anything, so the order and rules are enforced rather than improvised. Reach for individual primitives only when no recipe covers the task.

Each item's branch name is derived by Baron from its type role — use the name Baron returns verbatim, never invent one. Containers (epic, initiative) have no branch by design.

Where a provider lacks a capability, Baron negotiates it explicitly: it errors, emulates it (for example hierarchy via labels), or degrades with a warning, according to policy. An emulated or empty result from a degraded capability is expected behaviour and should not be reported as a failure.

Reading a provider natively is fine, but route every work-item CHANGE through Baron so the role mapping and gap policy apply.`;

export interface McpServerOptions {
  /**
   * Supplies the one-line "outdated" notice (or undefined). Defaults to a live npm-registry check;
   * injectable for tests and disabled entirely via BARON_NO_UPDATE_CHECK.
   */
  readonly updateNotice?: () => string | undefined;
}

/**
 * Append the update notice as an ADDITIONAL content block. The first block stays untouched: it is
 * parseable JSON that agents (and our tests) read with JSON.parse — prepending prose there would
 * break every consumer. Error results are left alone so the notice never muddies failure handling.
 */
export function withUpdateNotice(result: ToolResult, notice: string | undefined): ToolResult {
  if (notice === undefined || result.isError === true) return result;
  return { ...result, content: [...result.content, { type: 'text', text: notice }] };
}

/**
 * Wire the bound ports' primitives onto a low-level MCP {@link Server}. It advertises only the tools
 * for ports present in {@link McpPorts} and routes each call to the right port by name prefix. The
 * handlers only marshal — all translation lives in the ports (invariant #4). The pure tool-definition
 * / result shapes are structurally the SDK's, cast at this single boundary to bridge readonly /
 * zod-inferred nominal differences while keeping `tools.ts` SDK-free.
 */
export function createMcpServer(ports: McpPorts, options: McpServerOptions = {}): Server {
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: SERVER_INSTRUCTIONS,
  });
  const updateNotice =
    options.updateNotice ??
    startUpdateCheck({ name: OWN_PACKAGE.name, currentVersion: OWN_PACKAGE.version }).notice;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: activeToolDefinitions(ports) as unknown as Tool[],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await dispatchTool(ports, request.params.name, request.params.arguments);
    return withUpdateNotice(result, updateNotice()) as unknown as CallToolResult;
  });

  return server;
}
