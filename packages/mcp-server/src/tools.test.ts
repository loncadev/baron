import {
  defineGithubIssuesAdapter,
  exampleGithubRoleMap,
  exampleGithubTypeMap,
  recommendedGithubGapPolicy,
} from '@baron/adapter-github';
import { createMemoryTransport } from '@baron/conformance';
import { type IssuesPort, WORKFLOW_ROLES, WORK_ITEM_TYPE_ROLES } from '@baron/core';
import { describe, expect, it } from 'vitest';
import { MCP_TOOL_NAMES, TOOL_DEFINITIONS, callTool } from './tools.js';

function githubPort(): IssuesPort {
  const transport = createMemoryTransport({
    stateKey: exampleGithubRoleMap.stateKey,
    defaultDiscriminator: 'open',
  });
  return defineGithubIssuesAdapter(
    {
      roleMap: exampleGithubRoleMap,
      typeMap: exampleGithubTypeMap,
      gapPolicy: recommendedGithubGapPolicy,
    },
    transport,
  );
}

function parse(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

describe('TOOL_DEFINITIONS', () => {
  it('exposes exactly the three implemented primitives', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual([
      MCP_TOOL_NAMES.create,
      MCP_TOOL_NAMES.get,
      MCP_TOOL_NAMES.transition,
    ]);
  });

  it('sources role/typeRole enums from the core unions (no magic-string drift)', () => {
    const create = TOOL_DEFINITIONS.find((t) => t.name === MCP_TOOL_NAMES.create);
    const transition = TOOL_DEFINITIONS.find((t) => t.name === MCP_TOOL_NAMES.transition);
    const typeRole = create?.inputSchema.properties.typeRole as { enum: string[] };
    const initialRole = create?.inputSchema.properties.initialRole as { enum: string[] };
    const role = transition?.inputSchema.properties.role as { enum: string[] };
    expect(typeRole.enum).toEqual([...WORK_ITEM_TYPE_ROLES]);
    expect(initialRole.enum).toEqual([...WORKFLOW_ROLES]);
    expect(role.enum).toEqual([...WORKFLOW_ROLES]);
  });

  it('locks every input schema to additionalProperties:false', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });
});

describe('callTool', () => {
  it('creates an issue and returns its normalized JSON', async () => {
    const result = await callTool(githubPort(), MCP_TOOL_NAMES.create, {
      title: 'Wire it',
      typeRole: 'task',
    });
    expect(result.isError).toBeUndefined();
    const issue = parse(result.content[0]?.text ?? '{}');
    expect(issue.provider).toBe('github');
    expect(issue.title).toBe('Wire it');
  });

  it('transitions a created issue and resolves the role back', async () => {
    const port = githubPort();
    const created = parse(
      await callTool(port, MCP_TOOL_NAMES.create, {
        title: 'x',
        typeRole: 'task',
      }).then((r) => r.content[0]?.text ?? '{}'),
    );
    const moved = await callTool(port, MCP_TOOL_NAMES.transition, {
      id: created.id,
      role: 'in_review',
    });
    expect(moved.isError).toBeUndefined();
    expect(parse(moved.content[0]?.text ?? '{}').role).toBe('in_review');
  });

  it('maps a BaronError to an isError result carrying the code', async () => {
    // 'blocked' is unmapped in the example GitHub role map -> RoleMappingError (code ROLE_MAPPING).
    const port = githubPort();
    const created = parse(
      await callTool(port, MCP_TOOL_NAMES.create, {
        title: 'x',
        typeRole: 'task',
      }).then((r) => r.content[0]?.text ?? '{}'),
    );
    const result = await callTool(port, MCP_TOOL_NAMES.transition, {
      id: created.id,
      role: 'blocked',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe('ROLE_MAPPING');
    expect(result.content[0]?.text).toContain('ROLE_MAPPING');
  });

  it('rejects an out-of-enum role as an INVALID_ARGS isError (never silent)', async () => {
    const result = await callTool(githubPort(), MCP_TOOL_NAMES.transition, {
      id: '1',
      role: 'shipped',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe('INVALID_ARGS');
  });

  it('rejects a missing required argument as INVALID_ARGS', async () => {
    const result = await callTool(githubPort(), MCP_TOOL_NAMES.create, { typeRole: 'task' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe('INVALID_ARGS');
  });

  it('returns an isError for an unknown tool name', async () => {
    const result = await callTool(githubPort(), 'baron_issue_delete', {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe('UNKNOWN_TOOL');
  });
});
