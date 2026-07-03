import {
  defineGithubIssuesAdapter,
  defineGithubScmAdapter,
  exampleGithubRoleMap,
  exampleGithubTypeMap,
  recommendedGithubGapPolicy,
} from '@lonca/baron-adapter-github';
import { createMemoryScmTransport, createMemoryTransport } from '@lonca/baron-conformance';
import type { IssuesPort, ScmPort } from '@lonca/baron-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createMcpServer } from './server.js';
import { MCP_TOOL_NAMES, type McpPorts, SCM_TOOL_NAMES } from './tools.js';

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

function githubScmPort(): ScmPort {
  return defineGithubScmAdapter(createMemoryScmTransport());
}

/** Drive the server through the real MCP protocol over a linked in-memory transport pair. */
async function connectClient(ports: McpPorts, notice?: string): Promise<Client> {
  // A fixed updateNotice keeps the suite network-free (the default checker calls the npm registry).
  const server = createMcpServer(ports, { updateNotice: () => notice });
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
  it('advertises only the issue tools when only the issues port is bound', async () => {
    const client = await connectClient({ issues: githubPort() });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        MCP_TOOL_NAMES.create,
        MCP_TOOL_NAMES.get,
        MCP_TOOL_NAMES.transition,
        MCP_TOOL_NAMES.comment,
        MCP_TOOL_NAMES.link,
        MCP_TOOL_NAMES.assign,
        MCP_TOOL_NAMES.iterations,
        MCP_TOOL_NAMES.setIteration,
        MCP_TOOL_NAMES.query,
      ].sort(),
    );
  });

  it('advertises issue + scm tools when both ports are bound', async () => {
    const client = await connectClient({ issues: githubPort(), scm: githubScmPort() });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain(MCP_TOOL_NAMES.create);
    expect(names).toContain(SCM_TOOL_NAMES.branchCreate);
    expect(names).toContain(SCM_TOOL_NAMES.prCreate);
    expect(names).toContain(SCM_TOOL_NAMES.prThread);
  });

  it('appends an outdated notice as a separate content block over the real protocol', async () => {
    const client = await connectClient({ issues: githubPort() }, '⚠️ baron outdated');
    const result = (await client.callTool({
      name: MCP_TOOL_NAMES.create,
      arguments: { title: 'x', typeRole: 'task' },
    })) as ToolCallResult;
    expect(result.content).toHaveLength(2);
    // First block stays parseable JSON; the notice rides its own block.
    expect(JSON.parse(result.content?.[0]?.text ?? '').title).toBe('x');
    expect(result.content?.[1]?.text).toBe('⚠️ baron outdated');
  });

  it('creates an issue through a tool call (result shape passes SDK validation)', async () => {
    const client = await connectClient({ issues: githubPort() });
    const result = await call(client, MCP_TOOL_NAMES.create, { title: 'e2e', typeRole: 'task' });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result)).provider).toBe('github');
  });

  it('opens a pull request through an scm tool call', async () => {
    const client = await connectClient({ scm: githubScmPort() });
    const result = await call(client, SCM_TOOL_NAMES.prCreate, {
      title: 'e2e pr',
      sourceBranch: 'feature/x',
      targetBranch: 'main',
      draft: true,
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result)).draft).toBe(true);
  });

  it('routes an scm call to a PORT_UNBOUND error when scm is not configured', async () => {
    const client = await connectClient({ issues: githubPort() });
    const result = await call(client, SCM_TOOL_NAMES.branchCreate, {
      name: 'feature/x',
      fromBranch: 'main',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe('PORT_UNBOUND');
  });

  it('surfaces a BaronError as an isError tool result carrying the code', async () => {
    const client = await connectClient({ issues: githubPort() });
    const created = await call(client, MCP_TOOL_NAMES.create, { title: 'x', typeRole: 'task' });
    const id = JSON.parse(textOf(created)).id as string;
    const result = await call(client, MCP_TOOL_NAMES.transition, { id, role: 'blocked' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe('ROLE_MAPPING');
  });
});
