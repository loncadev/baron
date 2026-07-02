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
  type NativeRunStage,
  type NativeTriggerResult,
  type Pipeline,
  type PipelineQuery,
  type RunQuery,
  type TriggerInput,
} from '@lonca/baron-core';
import * as azdev from 'azure-devops-node-api';
import {
  type Build,
  BuildResult,
  BuildStatus,
  TaskResult,
  TimelineRecordState,
} from 'azure-devops-node-api/interfaces/BuildInterfaces.js';
import { AZURE_DEVOPS_PROVIDER } from './provider.js';

export interface AzureDevOpsCiTransportOptions {
  readonly organization: string;
  readonly project: string;
  readonly token: string;
}

/** Azure Pipelines capabilities. Stages come from the build timeline (run detail). */
export const azureDevOpsCiManifest: CiManifest = {
  provider: AZURE_DEVOPS_PROVIDER,
  ci: {
    canTrigger: true,
    canCancel: true,
    hasStages: true,
    hasApprovalGates: true,
    providesLogs: true,
    hasArtifacts: true,
  },
};

/**
 * Azure's fixed enums → normalized RunStatus. A finished unit is decided by its `result`, an in-flight
 * one by its `status`; 'Completed' is intentionally absent so a finished unit is always classified by
 * its result. Covers BOTH the build axes (BuildStatus / BuildResult) and the timeline axes
 * (TimelineRecordState / TaskResult) for stages — the enums overlap (Succeeded/Failed/Canceled/
 * InProgress) and the few extras are added here.
 */
export const azureDevOpsCiStatusMaps: CiStatusMaps = {
  status: {
    InProgress: 'running',
    Cancelling: 'running',
    Postponed: 'queued',
    NotStarted: 'queued',
    Pending: 'queued', // TimelineRecordState
    None: 'unknown',
  },
  result: {
    Succeeded: 'succeeded',
    PartiallySucceeded: 'failed',
    Failed: 'failed',
    Canceled: 'canceled',
    Skipped: 'skipped', // TaskResult
    SucceededWithIssues: 'failed', // TaskResult
    Abandoned: 'canceled', // TaskResult
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
 * Live `ci` transport over the Azure DevOps REST API (azure-devops-node-api BuildApi): pipelines,
 * runs, run detail (with timeline stages), a size-aware log tail, plus trigger (queueBuild) and
 * cancel (updateBuild → Cancelling). The BuildApi client is built lazily and cached.
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
      const buildId = Number(id);
      const b = await build.getBuild(project, buildId);
      const timeline = await build.getBuildTimeline(project, buildId).catch(() => undefined);
      const records = timeline?.records ?? [];
      // Surface top-level Stage records; a classic single-stage pipeline exposes Jobs instead.
      const stageRecords = records.filter((r) => r.type === 'Stage');
      const chosen =
        stageRecords.length > 0 ? stageRecords : records.filter((r) => r.type === 'Job');
      const stages: NativeRunStage[] = chosen
        .slice()
        .sort((a, c) => (a.order ?? 0) - (c.order ?? 0))
        .map((r) => ({
          name: r.name ?? '',
          status: r.state !== undefined ? (TimelineRecordState[r.state] ?? 'Pending') : 'Pending',
          // TaskResult.Succeeded is 0, so test against null/undefined, not falsiness.
          result: r.result != null ? TaskResult[r.result] : undefined,
        }));
      return { ...toNativeRun(b), stages };
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

    async triggerRun(input: TriggerInput): Promise<NativeTriggerResult> {
      const build = await api();
      const queued = await build.queueBuild(
        {
          definition: { id: Number(input.pipelineId) },
          ...(input.ref !== undefined
            ? {
                sourceBranch: input.ref.startsWith(REFS_HEADS)
                  ? input.ref
                  : `${REFS_HEADS}${input.ref}`,
              }
            : {}),
          ...(input.variables !== undefined ? { parameters: JSON.stringify(input.variables) } : {}),
        },
        project,
      );
      return { accepted: true, run: toNativeRun(queued) };
    },

    async cancelRun(runId: string): Promise<NativeRun> {
      const build = await api();
      // Azure cancels a build by transitioning it to the Cancelling status.
      const updated = await build.updateBuild(
        { status: BuildStatus.Cancelling },
        project,
        Number(runId),
      );
      return toNativeRun(updated);
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
