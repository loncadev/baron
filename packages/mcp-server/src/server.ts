import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { type McpPorts, type ToolResult, activeToolDefinitions, dispatchTool } from './tools.js';
import { startUpdateCheck } from './update-check.js';
import { OWN_PACKAGE } from './version.js';

export const SERVER_INFO = { name: 'baron', version: OWN_PACKAGE.version } as const;

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
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
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
