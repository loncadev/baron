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
import { SERVER_INSTRUCTIONS, createMcpServer } from './server.js';
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
        MCP_TOOL_NAMES.update,
        MCP_TOOL_NAMES.transition,
        MCP_TOOL_NAMES.reconcile,
        MCP_TOOL_NAMES.block,
        MCP_TOOL_NAMES.unblock,
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
    const result = await call(client, MCP_TOOL_NAMES.transition, { id, role: 'ready' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe('ROLE_MAPPING');
  });
});

describe('server instructions', () => {
  it('reaches the client on initialize', async () => {
    const client = await connectClient({ issues: githubPort() });
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
  });

  it('stays within the ~2KB budget clients truncate at', () => {
    // Claude Code truncates server instructions together with tool descriptions, so exceeding this
    // silently costs the guidance rather than failing loudly. Assert it instead of hoping.
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(2048);
  });

  it('teaches the role vocabulary and prefers recipes over primitives', () => {
    // When tool definitions are deferred (tool search on by default), this text is the only thing
    // the model sees up front — losing either of these turns Baron back into a bag of endpoints.
    for (const role of ['backlog', 'ready', 'in_progress', 'in_review', 'done']) {
      expect(SERVER_INSTRUCTIONS).toContain(role);
    }
    expect(SERVER_INSTRUCTIONS).toContain('baron_recipe_run');
  });
});

// The guarantee has to hold over the wire, not just in dispatch: an agent talks to the protocol.
describe('mutation channel over the MCP protocol', () => {
  it('lists the mutating tool but refuses to run it in recipe-only mode', async () => {
    const client = await connectClient({ issues: githubPort(), mutationChannel: 'recipe-only' });
    const { tools } = await client.listTools();
    // Still listed: hiding it would trade an enforceable rule for an obscured one, and an agent
    // that cannot see a tool cannot be told why it may not use it.
    expect(tools.map((t) => t.name)).toContain(MCP_TOOL_NAMES.transition);

    const result = await call(client, MCP_TOOL_NAMES.transition, { id: '1', role: 'in_review' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe('MUTATION_OUTSIDE_RECIPE');
  });
});
