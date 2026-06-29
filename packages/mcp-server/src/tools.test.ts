import {
  defineGithubIssuesAdapter,
  defineGithubScmAdapter,
  exampleGithubRoleMap,
  exampleGithubTypeMap,
  recommendedGithubGapPolicy,
} from '@baron/adapter-github';
import {
  createMemoryCiTransport,
  createMemoryDeployTransport,
  createMemoryNotifyTransport,
  createMemoryScmTransport,
  createMemoryTransport,
} from '@baron/conformance';
import {
  BaseCiAdapter,
  BaseDeployAdapter,
  BaseNotifyAdapter,
  type CiManifest,
  type CiPort,
  type CiStatusMaps,
  type DeployManifest,
  type DeployPort,
  type DeployStatusMaps,
  type IssuesPort,
  type NotifyManifest,
  type NotifyPort,
  type ScmPort,
  WORKFLOW_ROLES,
  WORK_ITEM_TYPE_ROLES,
} from '@baron/core';
import { KnowledgeLoop, createMemoryKnowledgeStore } from '@baron/knowledge-loop';
import { describe, expect, it } from 'vitest';
import {
  CI_TOOL_NAMES,
  DEPLOY_TOOL_NAMES,
  LOOP_TOOL_NAMES,
  MCP_TOOL_NAMES,
  NATIVE_TOOL_NAMES,
  NOTIFY_TOOL_NAMES,
  type NativeAccess,
  SCM_TOOL_NAMES,
  TOOL_DEFINITIONS,
  activeToolDefinitions,
  callCiTool,
  callDeployTool,
  callLoopTool,
  callNotifyTool,
  callScmTool,
  callTool,
  dispatchTool,
} from './tools.js';

function scmPort(): ScmPort {
  return defineGithubScmAdapter(createMemoryScmTransport());
}

const ciManifest: CiManifest = {
  provider: 'mem',
  ci: {
    canTrigger: false,
    canCancel: false,
    hasStages: false,
    hasApprovalGates: false,
    providesLogs: true,
    hasArtifacts: false,
  },
};
const ciMaps: CiStatusMaps = {
  status: { inProgress: 'running' },
  result: { succeeded: 'succeeded' },
};
function ciPort(): CiPort {
  return new BaseCiAdapter(ciManifest, ciMaps, createMemoryCiTransport());
}

describe('ci tools', () => {
  it('lists runs with a normalized status', async () => {
    const result = await callCiTool(ciPort(), CI_TOOL_NAMES.runs, {});
    expect(result.isError).toBeUndefined();
    const runs = JSON.parse(result.content[0]?.text ?? '[]') as Array<{ status: string }>;
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((r) => typeof r.status === 'string')).toBe(true);
  });

  it('gets one run and fetches a size-aware log chunk', async () => {
    const detail = await callCiTool(ciPort(), CI_TOOL_NAMES.runGet, { id: '1' });
    expect(detail.isError).toBeUndefined();
    const logs = await callCiTool(ciPort(), CI_TOOL_NAMES.runLogs, { runId: '1' });
    const chunk = JSON.parse(logs.content[0]?.text ?? '{}') as { truncated: boolean };
    expect(typeof chunk.truncated).toBe('boolean');
  });

  it('defaults the runs limit and respects an explicit one', async () => {
    const captured: Array<number | undefined> = [];
    const port = {
      runs: async (q: { limit?: number }) => {
        captured.push(q.limit);
        return [];
      },
    } as unknown as CiPort;
    await callCiTool(port, CI_TOOL_NAMES.runs, {});
    await callCiTool(port, CI_TOOL_NAMES.runs, { limit: 5 });
    expect(captured).toEqual([50, 5]);
  });

  it('advertises ci tools only when the ci port is bound', () => {
    expect(activeToolDefinitions({ ci: ciPort() }).some((t) => t.name === CI_TOOL_NAMES.runs)).toBe(
      true,
    );
    expect(activeToolDefinitions({}).some((t) => t.name === CI_TOOL_NAMES.runs)).toBe(false);
  });

  it('dispatches ci tools and reports PORT_UNBOUND when unbound', async () => {
    const ok = await dispatchTool({ ci: ciPort() }, CI_TOOL_NAMES.runs, {});
    expect(ok.isError).toBeUndefined();
    const unbound = await dispatchTool({}, CI_TOOL_NAMES.runs, {});
    expect(unbound.isError).toBe(true);
    expect(unbound.structuredContent?.code).toBe('PORT_UNBOUND');
  });

  it('triggers a run (marshals pipelineId/ref/variables) and cancels a run', async () => {
    const calls: Array<{ tool: string; args: unknown }> = [];
    const port = {
      trigger: async (input: unknown) => {
        calls.push({ tool: 'trigger', args: input });
        return { accepted: true };
      },
      cancel: async (id: string) => {
        calls.push({ tool: 'cancel', args: id });
        return { id, status: 'canceled' };
      },
    } as unknown as CiPort;
    const triggered = await callCiTool(port, CI_TOOL_NAMES.runTrigger, {
      pipelineId: 'p1',
      ref: 'release',
      variables: { env: 'prod' },
    });
    expect(triggered.isError).toBeUndefined();
    const cancelled = await callCiTool(port, CI_TOOL_NAMES.runCancel, { runId: '9' });
    expect(cancelled.isError).toBeUndefined();
    expect(calls).toEqual([
      { tool: 'trigger', args: { pipelineId: 'p1', ref: 'release', variables: { env: 'prod' } } },
      { tool: 'cancel', args: '9' },
    ]);
  });

  it('rejects non-string trigger variables as INVALID_ARGS', async () => {
    const result = await callCiTool(ciPort(), CI_TOOL_NAMES.runTrigger, {
      pipelineId: 'p1',
      variables: { bad: 5 },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe('INVALID_ARGS');
  });
});

const notifyManifest: NotifyManifest = {
  provider: 'mem',
  notify: { channels: true, threads: true, richText: true },
};
function notifyPort(): NotifyPort {
  return new BaseNotifyAdapter(notifyManifest, createMemoryNotifyTransport());
}

describe('notify tools', () => {
  it('sends a message and returns a normalized notification', async () => {
    const result = await callNotifyTool(notifyPort(), NOTIFY_TOOL_NAMES.send, {
      text: 'deploy finished',
      channel: 'releases',
    });
    expect(result.isError).toBeUndefined();
    const sent = JSON.parse(result.content[0]?.text ?? '{}') as { id: string };
    expect(sent.id).toBeTruthy();
  });

  it('advertises + dispatches notify only when the port is bound', async () => {
    expect(
      activeToolDefinitions({ notify: notifyPort() }).some(
        (t) => t.name === NOTIFY_TOOL_NAMES.send,
      ),
    ).toBe(true);
    expect(activeToolDefinitions({}).some((t) => t.name === NOTIFY_TOOL_NAMES.send)).toBe(false);
    const unbound = await dispatchTool({}, NOTIFY_TOOL_NAMES.send, { text: 'x' });
    expect(unbound.structuredContent?.code).toBe('PORT_UNBOUND');
  });
});

describe('native escape hatch', () => {
  const okAccess: NativeAccess = async () => ({
    status: 200,
    ok: true,
    body: { ok: true },
    truncated: false,
  });

  it('marshals the native request (provider + method + path + query/body) to the access fn', async () => {
    const calls: Array<{ provider: string; req: unknown }> = [];
    const access: NativeAccess = async (provider, req) => {
      calls.push({ provider, req });
      return { status: 201, ok: true, body: {}, truncated: false };
    };
    const result = await dispatchTool({ nativeAccess: access }, NATIVE_TOOL_NAMES.request, {
      provider: 'azure-devops',
      method: 'POST',
      path: '/_apis/wit/workitems',
      query: { 'api-version': '7.1' },
      body: { title: 'x' },
    });
    expect(result.isError).toBeUndefined();
    expect(calls).toEqual([
      {
        provider: 'azure-devops',
        req: {
          method: 'POST',
          path: '/_apis/wit/workitems',
          query: { 'api-version': '7.1' },
          body: { title: 'x' },
        },
      },
    ]);
  });

  it('advertises the escape hatch only when nativeAccess is wired', () => {
    expect(
      activeToolDefinitions({ nativeAccess: okAccess }).some(
        (t) => t.name === NATIVE_TOOL_NAMES.request,
      ),
    ).toBe(true);
    expect(activeToolDefinitions({}).some((t) => t.name === NATIVE_TOOL_NAMES.request)).toBe(false);
  });

  it('reports unavailable when no escape hatch is wired', async () => {
    const result = await dispatchTool({}, NATIVE_TOOL_NAMES.request, {
      provider: 'x',
      method: 'GET',
      path: '/',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe('PORT_UNBOUND');
  });
});

const deployManifest: DeployManifest = {
  provider: 'mem',
  deploy: { environments: true, deployments: true, canTrigger: false },
};
const deployMaps: DeployStatusMaps = {
  status: { InProgress: 'running' },
  result: { Succeeded: 'succeeded' },
};
function deployPort(): DeployPort {
  return new BaseDeployAdapter(deployManifest, deployMaps, createMemoryDeployTransport());
}

describe('deploy tools', () => {
  it('lists environments and deployments with a normalized status', async () => {
    const envs = await callDeployTool(deployPort(), DEPLOY_TOOL_NAMES.environments, {});
    expect(envs.isError).toBeUndefined();
    const deps = await callDeployTool(deployPort(), DEPLOY_TOOL_NAMES.deployments, {});
    expect(deps.isError).toBeUndefined();
    const list = JSON.parse(deps.content[0]?.text ?? '[]') as Array<{ status: string }>;
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((d) => typeof d.status === 'string')).toBe(true);
  });

  it('advertises + dispatches deploy only when the port is bound', async () => {
    expect(
      activeToolDefinitions({ deploy: deployPort() }).some(
        (t) => t.name === DEPLOY_TOOL_NAMES.deployments,
      ),
    ).toBe(true);
    expect(activeToolDefinitions({}).some((t) => t.name === DEPLOY_TOOL_NAMES.deployments)).toBe(
      false,
    );
    const unbound = await dispatchTool({}, DEPLOY_TOOL_NAMES.deployments, {});
    expect(unbound.structuredContent?.code).toBe('PORT_UNBOUND');
  });
});

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

  it('defaults the query limit and respects an explicit one', async () => {
    const captured: Array<number | undefined> = [];
    const port = {
      query: async (q: { limit?: number }) => {
        captured.push(q.limit);
        return [];
      },
    } as unknown as IssuesPort;
    await callTool(port, MCP_TOOL_NAMES.query, {});
    await callTool(port, MCP_TOOL_NAMES.query, { limit: 7 });
    expect(captured).toEqual([50, 7]);
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
