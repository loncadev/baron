import {
  defineGithubIssuesAdapter,
  defineGithubScmAdapter,
  exampleGithubRoleMap,
  exampleGithubTypeMap,
  recommendedGithubGapPolicy,
} from '@lonca/baron-adapter-github';
import { createMemoryScmTransport, createMemoryTransport } from '@lonca/baron-conformance';
import type { IssuesPort, ScmPort } from '@lonca/baron-core';
import { KNOWN_PROVIDERS, getProviderDescriptor } from '@lonca/baron-providers';
import { BUILTIN_RECIPE_NAMES } from '@lonca/baron-recipes';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from './consolidated.js';
import { SERVER_INSTRUCTIONS, createMcpServer } from './server.js';
import type { McpPorts } from './tools.js';

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
  it('advertises three issue tools when only the issues port is bound', async () => {
    const client = await connectClient({ issues: githubPort() });
    const { tools } = await client.listTools();
    // One per verb rather than one per endpoint: thirteen primitives behind three published tools.
    expect(tools.map((t) => t.name).sort()).toEqual(
      [TOOL_NAMES.issueRead, TOOL_NAMES.issueWrite, TOOL_NAMES.issueMove].sort(),
    );
  });

  it('advertises issue + scm tools when both ports are bound', async () => {
    const client = await connectClient({ issues: githubPort(), scm: githubScmPort() });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain(TOOL_NAMES.issueWrite);
    expect(names).toContain(TOOL_NAMES.scmRead);
    expect(names).toContain(TOOL_NAMES.scmWrite);
  });

  it('appends an outdated notice as a separate content block over the real protocol', async () => {
    const client = await connectClient({ issues: githubPort() }, '⚠️ baron outdated');
    const result = (await client.callTool({
      name: TOOL_NAMES.issueWrite,
      arguments: { op: 'create', title: 'x', typeRole: 'task' },
    })) as ToolCallResult;
    expect(result.content).toHaveLength(2);
    // First block stays parseable JSON; the notice rides its own block.
    expect(JSON.parse(result.content?.[0]?.text ?? '').title).toBe('x');
    expect(result.content?.[1]?.text).toBe('⚠️ baron outdated');
  });

  it('creates an issue through a tool call (result shape passes SDK validation)', async () => {
    const client = await connectClient({ issues: githubPort() });
    const result = await call(client, TOOL_NAMES.issueWrite, {
      op: 'create',
      title: 'e2e',
      typeRole: 'task',
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result)).provider).toBe('github');
  });

  it('opens a pull request through an scm tool call', async () => {
    const client = await connectClient({ scm: githubScmPort() });
    const result = await call(client, TOOL_NAMES.scmWrite, {
      op: 'pr_create',
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
    const result = await call(client, TOOL_NAMES.scmWrite, {
      op: 'branch_create',
      name: 'feature/x',
      fromBranch: 'main',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe('PORT_UNBOUND');
  });

  it('surfaces a BaronError as an isError tool result carrying the code', async () => {
    const client = await connectClient({ issues: githubPort() });
    const created = await call(client, TOOL_NAMES.issueWrite, {
      op: 'create',
      title: 'x',
      typeRole: 'task',
    });
    const id = JSON.parse(textOf(created)).id as string;
    const result = await call(client, TOOL_NAMES.issueMove, {
      op: 'transition',
      id,
      role: 'ready',
    });
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

  it('names every provider and every built-in recipe, from the registries rather than by hand', () => {
    // The 0.40.0 handshake still said "Azure DevOps, GitHub, Slack" and five recipes — two providers
    // and three recipes after they shipped. Derived lists cannot go stale that way.
    for (const id of KNOWN_PROVIDERS) {
      expect(SERVER_INSTRUCTIONS).toContain(getProviderDescriptor(id).displayName);
    }
    for (const name of BUILTIN_RECIPE_NAMES) expect(SERVER_INSTRUCTIONS).toContain(name);
  });
});

// The guarantee has to hold over the wire, not just in dispatch: an agent talks to the protocol.
describe('mutation channel over the MCP protocol', () => {
  it('lists the mutating tool but refuses to run it in recipe-only mode', async () => {
    const client = await connectClient({ issues: githubPort(), mutationChannel: 'recipe-only' });
    const { tools } = await client.listTools();
    // Still listed: hiding it would trade an enforceable rule for an obscured one, and an agent
    // that cannot see a tool cannot be told why it may not use it.
    expect(tools.map((t) => t.name)).toContain(TOOL_NAMES.issueMove);

    const result = await call(client, TOOL_NAMES.issueMove, {
      op: 'transition',
      id: '1',
      role: 'in_review',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe('MUTATION_OUTSIDE_RECIPE');
  });
});

describe('the notice a server produces when nobody hands it one', () => {
  // Every other test here injects `updateNotice`, so the default path — the seam where the companion
  // check and the registry check are composed — was never exercised. That is the shape of bug this
  // repository keeps finding: both halves correct, the join wrong and invisible.
  it('carries the stale-companion warning through a real tool call', async () => {
    const previous = {
      plugin: process.env.BARON_PLUGIN_VERSION,
      noCheck: process.env.BARON_NO_UPDATE_CHECK,
    };
    // Disabling the registry check keeps this network-free and leaves the companion as the only
    // possible source, so a pass cannot come from the other branch.
    process.env.BARON_NO_UPDATE_CHECK = '1';
    process.env.BARON_PLUGIN_VERSION = '0.1.0';
    try {
      const server = createMcpServer({ issues: githubPort() });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: 'baron-test-client', version: '0.0.0' }, {});
      await client.connect(clientTransport);

      const result = await call(client, TOOL_NAMES.issueWrite, {
        op: 'create',
        title: 'anything',
        typeRole: 'task',
      });
      const blocks = result.content ?? [];
      // The notice is its OWN block: the first stays parseable JSON, which every consumer relies on.
      expect(() => JSON.parse(blocks[0]?.text ?? '')).not.toThrow();
      expect(blocks.map((b) => b.text).join(' ')).toContain('0.1.0');
    } finally {
      // Removed rather than assigned undefined: `process.env.X = undefined` stores the STRING
      // "undefined", which a later reader sees as a set value and this very check would act on.
      for (const [key, value] of [
        ['BARON_PLUGIN_VERSION', previous.plugin],
        ['BARON_NO_UPDATE_CHECK', previous.noCheck],
      ] as const) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  });
});
