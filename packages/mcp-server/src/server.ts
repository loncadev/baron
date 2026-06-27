import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { type McpPorts, activeToolDefinitions, dispatchTool } from './tools.js';

export const SERVER_INFO = { name: 'baron', version: '0.0.0' } as const;

/**
 * Wire the bound ports' primitives onto a low-level MCP {@link Server}. It advertises only the tools
 * for ports present in {@link McpPorts} and routes each call to the right port by name prefix. The
 * handlers only marshal — all translation lives in the ports (invariant #4). The pure tool-definition
 * / result shapes are structurally the SDK's, cast at this single boundary to bridge readonly /
 * zod-inferred nominal differences while keeping `tools.ts` SDK-free.
 */
export function createMcpServer(ports: McpPorts): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: activeToolDefinitions(ports) as unknown as Tool[],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await dispatchTool(ports, request.params.name, request.params.arguments);
    return result as unknown as CallToolResult;
  });

  return server;
}
