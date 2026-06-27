import {
  defineGithubIssuesAdapter,
  exampleGithubRoleMap,
  exampleGithubTypeMap,
  recommendedGithubGapPolicy,
} from '@baron/adapter-github';
import { createMemoryTransport } from '@baron/conformance';
import type { IssuesPort } from '@baron/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createMcpServer } from './server.js';
import { MCP_TOOL_NAMES } from './tools.js';

function githubPort(): IssuesPort {
  return defineGithubIssuesAdapter(
    {
      roleMap: exampleGithubRoleMap,
      typeMap: exampleGithubTypeMap,
      gapPolicy: recommendedGithubGapPolicy,
    },
    createMemoryTransport({
      stateKey: exampleGithubRoleMap.stateKey,
      defaultDiscriminator: 'open',
    }),
  );
}

/** Drive the server through the real MCP protocol over a linked in-memory transport pair. */
async function connectClient(port: IssuesPort): Promise<Client> {
  const server = createMcpServer(port);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'baron-test-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

/** The result shape we assert on; callTool's SDK return is a wider union (legacy toolResult). */
interface ToolCallResult {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: { code?: string };
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolCallResult;
}

function textOf(result: ToolCallResult): string {
  return result.content?.[0]?.text ?? '';
}

describe('createMcpServer (end-to-end over the MCP protocol)', () => {
  it('advertises exactly the three issue tools', async () => {
    const client = await connectClient(githubPort());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [MCP_TOOL_NAMES.create, MCP_TOOL_NAMES.get, MCP_TOOL_NAMES.transition].sort(),
    );
  });

  it('creates an issue through a tool call (result shape passes SDK validation)', async () => {
    const client = await connectClient(githubPort());
    const result = await call(client, MCP_TOOL_NAMES.create, { title: 'e2e', typeRole: 'task' });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result)).provider).toBe('github');
  });

  it('surfaces a BaronError as an isError tool result carrying the code', async () => {
    const client = await connectClient(githubPort());
    const created = await call(client, MCP_TOOL_NAMES.create, { title: 'x', typeRole: 'task' });
    const id = JSON.parse(textOf(created)).id as string;
    const result = await call(client, MCP_TOOL_NAMES.transition, { id, role: 'blocked' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe('ROLE_MAPPING');
  });
});
