import type { IssuesPort } from '@baron/core';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITIONS, callTool } from './tools.js';

export const SERVER_INFO = { name: 'baron', version: '0.0.0' } as const;

/**
 * Wire the issues primitives onto a low-level MCP {@link Server} over an injected {@link IssuesPort}.
 * The handlers only marshal — all translation lives in the port (invariant #4). The pure
 * {@link TOOL_DEFINITIONS} / {@link callTool} shapes are structurally the SDK's, cast at this single
 * boundary to bridge readonly / zod-inferred nominal differences while keeping `tools.ts` SDK-free.
 */
export function createMcpServer(port: IssuesPort): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS as unknown as Tool[],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await callTool(port, request.params.name, request.params.arguments);
    return result as unknown as CallToolResult;
  });

  return server;
}
