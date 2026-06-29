import {
  BaseCiAdapter,
  type CiManifest,
  type CiStatusMaps,
  type CiTransport,
  type GapPolicy,
  type LogOptions,
  type Logger,
  type NativeLog,
  type NativeRun,
  type NativeRunDetail,
  type Pipeline,
  type PipelineQuery,
  type RunQuery,
} from '@baron/core';
import * as azdev from 'azure-devops-node-api';
import {
  type Build,
  BuildResult,
  BuildStatus,
} from 'azure-devops-node-api/interfaces/BuildInterfaces.js';
import { AZURE_DEVOPS_PROVIDER } from './provider.js';

export interface AzureDevOpsCiTransportOptions {
  readonly organization: string;
  readonly project: string;
  readonly token: string;
}

/**
 * Azure Pipelines capabilities. `hasStages` is false in slice 1: the read surface does not yet
 * surface per-stage records (the build timeline uses different native enums — a later slice).
 */
export const azureDevOpsCiManifest: CiManifest = {
  provider: AZURE_DEVOPS_PROVIDER,
  ci: {
    canTrigger: true,
    canCancel: true,
    hasStages: false,
    hasApprovalGates: true,
    providesLogs: true,
    hasArtifacts: true,
  },
};

/**
 * Azure's fixed build enums → normalized RunStatus. A finished build is decided by `result`; an
 * in-flight build by `status`. 'Completed' is intentionally absent from the status map so a finished
 * build is always classified by its result (the transport omits `result` until it is meaningful).
 */
export const azureDevOpsCiStatusMaps: CiStatusMaps = {
  status: {
    InProgress: 'running',
    Cancelling: 'running',
    Postponed: 'queued',
    NotStarted: 'queued',
    None: 'unknown',
  },
  result: {
    Succeeded: 'succeeded',
    PartiallySucceeded: 'failed',
    Failed: 'failed',
    Canceled: 'canceled',
  },
};

const REFS_HEADS = 'refs/heads/';
const DEFAULT_RUN_LIMIT = 50;
const DEFAULT_TAIL_LINES = 200;

type BuildApi = Awaited<ReturnType<InstanceType<typeof azdev.WebApi>['getBuildApi']>>;

const iso = (d: Date | undefined): string | undefined =>
  d instanceof Date ? d.toISOString() : d === undefined ? undefined : String(d);

function toNativeRun(b: Build): NativeRun {
  const status = b.status !== undefined ? (BuildStatus[b.status] ?? 'None') : 'None';
  // Azure stamps result=None on a not-yet-finished build; treat that as "no result yet" so the
  // status (phase) axis classifies it, instead of mapping a phantom result.
  const result =
    b.result !== undefined && b.result !== BuildResult.None ? BuildResult[b.result] : undefined;
  const branch = b.sourceBranch?.startsWith(REFS_HEADS)
    ? b.sourceBranch.slice(REFS_HEADS.length)
    : b.sourceBranch;
  return {
    id: String(b.id ?? ''),
    pipelineId: String(b.definition?.id ?? ''),
    pipelineName: b.definition?.name,
    status,
    result,
    branch,
    number: b.buildNumber,
    url: b._links?.web?.href as string | undefined,
    createdAt: iso(b.queueTime),
    finishedAt: iso(b.finishTime),
  };
}

/**
 * Live `ci` transport over the Azure DevOps REST API (azure-devops-node-api BuildApi). Read-only in
 * slice 1: pipelines, runs, run detail, and a size-aware log tail. The BuildApi client is built
 * lazily and cached.
 */
export function createAzureDevOpsCiTransport(options: AzureDevOpsCiTransportOptions): CiTransport {
  const { organization, project, token } = options;
  const orgUrl = `https://dev.azure.com/${organization}`;

  let buildApi: Promise<BuildApi> | undefined;
  const api = (): Promise<BuildApi> => {
    buildApi ??= new azdev.WebApi(orgUrl, azdev.getPersonalAccessTokenHandler(token)).getBuildApi();
    return buildApi;
  };

  return {
    async listPipelines(query: PipelineQuery): Promise<readonly Pipeline[]> {
      const build = await api();
      const defs = await build.getDefinitions(project);
      const list = query.limit !== undefined ? defs.slice(0, query.limit) : defs;
      return list.map((d) => ({
        id: String(d.id ?? ''),
        name: d.name ?? '',
        url: d._links?.web?.href as string | undefined,
      }));
    },

    async listRuns(query: RunQuery): Promise<readonly NativeRun[]> {
      const build = await api();
      const definitions = query.pipelineId !== undefined ? [Number(query.pipelineId)] : undefined;
      const top = query.limit ?? DEFAULT_RUN_LIMIT;
      // getBuilds is positional; `top` is the 13th parameter (10 undefined filters precede it). Branch
      // is filtered client-side within the fetched window to avoid an 18-argument positional call.
      const builds = await build.getBuilds(
        project,
        definitions,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        top,
      );
      const runs = builds.map(toNativeRun);
      return query.branch !== undefined ? runs.filter((r) => r.branch === query.branch) : runs;
    },

    async getRun(id: string): Promise<NativeRunDetail> {
      const build = await api();
      const b = await build.getBuild(project, Number(id));
      // Stages not surfaced in slice 1 (hasStages: false) — the timeline uses different native enums.
      return { ...toNativeRun(b), stages: [] };
    },

    async fetchLogs(runId: string, options: LogOptions): Promise<NativeLog> {
      const build = await api();
      const buildId = Number(runId);
      const logs = await build.getBuildLogs(project, buildId);
      if (logs.length === 0) return { content: '', truncated: false };
      const last = logs[logs.length - 1];
      const logId = last?.id;
      if (logId === undefined) return { content: '', truncated: false };
      const lineCount = last?.lineCount ?? 0;
      const tail = options.tailLines ?? DEFAULT_TAIL_LINES;
      const start = Math.max(0, lineCount - tail);
      const lines = await build.getBuildLogLines(project, buildId, logId, start, lineCount);
      return { content: lines.join('\n'), truncated: start > 0 || logs.length > 1 };
    },
  };
}

export function defineAzureDevOpsCiAdapter(
  transport: CiTransport,
  gapPolicy?: GapPolicy,
  logger?: Logger,
): BaseCiAdapter {
  return new BaseCiAdapter(
    azureDevOpsCiManifest,
    azureDevOpsCiStatusMaps,
    transport,
    gapPolicy,
    logger,
  );
}
