import {
  defineGithubIssuesAdapter,
  defineGithubScmAdapter,
  exampleGithubRoleMap,
  exampleGithubTypeMap,
  recommendedGithubGapPolicy,
} from '@baron/adapter-github';
import { createMemoryScmTransport, createMemoryTransport } from '@baron/conformance';
import { type IssuesPort, type ScmPort, WORKFLOW_ROLES, WORK_ITEM_TYPE_ROLES } from '@baron/core';
import { KnowledgeLoop, createMemoryKnowledgeStore } from '@baron/knowledge-loop';
import { describe, expect, it } from 'vitest';
import {
  LOOP_TOOL_NAMES,
  MCP_TOOL_NAMES,
  SCM_TOOL_NAMES,
  TOOL_DEFINITIONS,
  callLoopTool,
  callScmTool,
  callTool,
} from './tools.js';

function scmPort(): ScmPort {
  return defineGithubScmAdapter(createMemoryScmTransport());
}

function loop(): KnowledgeLoop {
  return new KnowledgeLoop(createMemoryKnowledgeStore());
}

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
  it('exposes the six implemented issue primitives', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual([
      MCP_TOOL_NAMES.create,
      MCP_TOOL_NAMES.get,
      MCP_TOOL_NAMES.transition,
      MCP_TOOL_NAMES.comment,
      MCP_TOOL_NAMES.link,
      MCP_TOOL_NAMES.query,
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

  it('comments on an issue', async () => {
    const port = githubPort();
    const created = parse(
      await callTool(port, MCP_TOOL_NAMES.create, { title: 'x', typeRole: 'task' }).then(
        (r) => r.content[0]?.text ?? '{}',
      ),
    );
    const result = await callTool(port, MCP_TOOL_NAMES.comment, {
      id: created.id,
      body: 'a note',
    });
    expect(result.isError).toBeUndefined();
    expect(parse(result.content[0]?.text ?? '{}').body).toBe('a note');
  });

  it('queries issues by role', async () => {
    const port = githubPort();
    const created = parse(
      await callTool(port, MCP_TOOL_NAMES.create, { title: 'x', typeRole: 'task' }).then(
        (r) => r.content[0]?.text ?? '{}',
      ),
    );
    await callTool(port, MCP_TOOL_NAMES.transition, { id: created.id, role: 'in_review' });
    const result = await callTool(port, MCP_TOOL_NAMES.query, { role: 'in_review' });
    expect(result.isError).toBeUndefined();
    const issues = JSON.parse(result.content[0]?.text ?? '[]') as Array<{ id: string }>;
    expect(issues.some((i) => i.id === created.id)).toBe(true);
  });

  it('links issues via label emulation on a flat provider and returns ok', async () => {
    const port = githubPort();
    const a = parse(
      await callTool(port, MCP_TOOL_NAMES.create, { title: 'a', typeRole: 'task' }).then(
        (r) => r.content[0]?.text ?? '{}',
      ),
    );
    const b = parse(
      await callTool(port, MCP_TOOL_NAMES.create, { title: 'b', typeRole: 'task' }).then(
        (r) => r.content[0]?.text ?? '{}',
      ),
    );
    const result = await callTool(port, MCP_TOOL_NAMES.link, {
      fromId: a.id,
      toId: b.id,
      type: 'blocks',
    });
    expect(result.isError).toBeUndefined();
    expect(parse(result.content[0]?.text ?? '{}').ok).toBe(true);
  });

  it('rejects an out-of-enum link type as INVALID_ARGS', async () => {
    const result = await callTool(githubPort(), MCP_TOOL_NAMES.link, {
      fromId: '1',
      toId: '2',
      type: 'mentions',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe('INVALID_ARGS');
  });
});

describe('callScmTool', () => {
  it('creates a branch', async () => {
    const result = await callScmTool(scmPort(), SCM_TOOL_NAMES.branchCreate, {
      name: 'feature/x',
      fromBranch: 'main',
    });
    expect(result.isError).toBeUndefined();
    expect(parse(result.content[0]?.text ?? '{}').name).toBe('feature/x');
  });

  it('opens a draft pull request', async () => {
    const result = await callScmTool(scmPort(), SCM_TOOL_NAMES.prCreate, {
      title: 'PR',
      sourceBranch: 'feature/x',
      targetBranch: 'main',
      draft: true,
    });
    expect(result.isError).toBeUndefined();
    expect(parse(result.content[0]?.text ?? '{}').draft).toBe(true);
  });

  it('adds a pull request thread', async () => {
    const port = scmPort();
    const pr = parse(
      await callScmTool(port, SCM_TOOL_NAMES.prCreate, {
        title: 'PR',
        sourceBranch: 'feature/x',
        targetBranch: 'main',
      }).then((r) => r.content[0]?.text ?? '{}'),
    );
    const result = await callScmTool(port, SCM_TOOL_NAMES.prThread, {
      pullRequestId: pr.id,
      body: 'looks good',
    });
    expect(result.isError).toBeUndefined();
    expect(parse(result.content[0]?.text ?? '{}').id).toBeTruthy();
  });

  it('rejects a non-boolean draft as INVALID_ARGS', async () => {
    const result = await callScmTool(scmPort(), SCM_TOOL_NAMES.prCreate, {
      title: 'PR',
      sourceBranch: 'feature/x',
      targetBranch: 'main',
      draft: 'yes',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe('INVALID_ARGS');
  });
});

describe('callLoopTool', () => {
  it('appends and queries a learning', async () => {
    const port = loop();
    const appended = await callLoopTool(port, LOOP_TOOL_NAMES.learningAppend, {
      title: 'Roles beat states',
      body: 'recipes speak roles',
      tags: ['design'],
    });
    expect(appended.isError).toBeUndefined();

    const queried = await callLoopTool(port, LOOP_TOOL_NAMES.learningQuery, { tag: 'design' });
    const learnings = JSON.parse(queried.content[0]?.text ?? '[]') as Array<{ title: string }>;
    expect(learnings.some((l) => l.title === 'Roles beat states')).toBe(true);
  });

  it('appends an open follow-up and lists it by status', async () => {
    const port = loop();
    await callLoopTool(port, LOOP_TOOL_NAMES.followupAppend, { title: 'Wire live smoke' });
    const listed = await callLoopTool(port, LOOP_TOOL_NAMES.followupList, { status: 'open' });
    const followups = JSON.parse(listed.content[0]?.text ?? '[]') as unknown[];
    expect(followups).toHaveLength(1);
  });

  it('rejects a missing learning title as INVALID_ARGS', async () => {
    const result = await callLoopTool(loop(), LOOP_TOOL_NAMES.learningAppend, { body: 'x' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe('INVALID_ARGS');
  });

  it('rejects an out-of-enum follow-up status as INVALID_ARGS', async () => {
    const result = await callLoopTool(loop(), LOOP_TOOL_NAMES.followupList, { status: 'archived' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe('INVALID_ARGS');
  });
});
