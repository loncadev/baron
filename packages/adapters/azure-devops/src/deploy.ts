import {
  BaseDeployAdapter,
  type DeployManifest,
  type DeployStatusMaps,
  type DeployTransport,
  type DeploymentQuery,
  type Environment,
  type EnvironmentQuery,
  type GapPolicy,
  type Logger,
  type NativeDeployment,
} from '@lonca/baron-core';
import * as azdev from 'azure-devops-node-api';
import { TaskResult } from 'azure-devops-node-api/interfaces/TaskAgentInterfaces.js';
import { AZURE_DEVOPS_PROVIDER } from './provider.js';

export interface AzureDevOpsDeployTransportOptions {
  readonly organization: string;
  readonly project: string;
  readonly token: string;
}

/** Azure Pipelines Environments + deployment execution records. Read-only (no trigger) in this slice. */
export const azureDevOpsDeployManifest: DeployManifest = {
  provider: AZURE_DEVOPS_PROVIDER,
  deploy: { environments: true, deployments: true, canTrigger: false },
};

/**
 * Azure's deployment execution `result` is a TaskResult; an unfinished record has no result and is
 * classified by the synthetic 'InProgress' phase. Mirrors the CI stage enum mapping.
 */
export const azureDevOpsDeployStatusMaps: DeployStatusMaps = {
  status: { InProgress: 'running' },
  result: {
    Succeeded: 'succeeded',
    SucceededWithIssues: 'succeeded',
    Failed: 'failed',
    Canceled: 'canceled',
    Skipped: 'skipped',
    Abandoned: 'canceled',
  },
};

const DEFAULT_LIMIT = 20;
const MAX_ENVIRONMENTS_SCANNED = 20;

type TaskAgentApi = Awaited<ReturnType<InstanceType<typeof azdev.WebApi>['getTaskAgentApi']>>;

const iso = (d: Date | undefined): string | undefined =>
  d instanceof Date ? d.toISOString() : d === undefined ? undefined : String(d);

export function createAzureDevOpsDeployTransport(
  options: AzureDevOpsDeployTransportOptions,
): DeployTransport {
  const { organization, project, token } = options;
  const orgUrl = `https://dev.azure.com/${organization}`;

  let taskApi: Promise<TaskAgentApi> | undefined;
  const api = (): Promise<TaskAgentApi> => {
    taskApi ??= new azdev.WebApi(
      orgUrl,
      azdev.getPersonalAccessTokenHandler(token),
    ).getTaskAgentApi();
    return taskApi;
  };

  return {
    async listEnvironments(query: EnvironmentQuery): Promise<readonly Environment[]> {
      const task = await api();
      const envs = await task.getEnvironments(project, undefined, undefined, query.limit);
      return envs.map((e) => ({ id: String(e.id ?? ''), name: e.name ?? '' }));
    },

    async listDeployments(query: DeploymentQuery): Promise<readonly NativeDeployment[]> {
      const task = await api();
      const envs = await task.getEnvironments(project);
      // Azure deployment records are per-environment; aggregate across the selected environments.
      const selected =
        query.environment !== undefined
          ? envs.filter((e) => e.name === query.environment || String(e.id) === query.environment)
          : envs.slice(0, MAX_ENVIRONMENTS_SCANNED);
      const limit = query.limit ?? DEFAULT_LIMIT;

      const out: NativeDeployment[] = [];
      for (const env of selected) {
        if (env.id === undefined) continue;
        const records = await task.getEnvironmentDeploymentExecutionRecords(
          project,
          env.id,
          undefined,
          limit,
        );
        for (const r of records) {
          const resultName = r.result != null ? TaskResult[r.result] : undefined;
          out.push({
            id: String(r.id ?? ''),
            environment: env.name ?? String(env.id),
            ...(resultName !== undefined ? { result: resultName } : { status: 'InProgress' }),
            ...(iso(r.queueTime) !== undefined ? { createdAt: iso(r.queueTime) } : {}),
            ...(iso(r.finishTime) !== undefined ? { finishedAt: iso(r.finishTime) } : {}),
          });
        }
      }
      out.sort((a, b) =>
        (b.finishedAt ?? b.createdAt ?? '').localeCompare(a.finishedAt ?? a.createdAt ?? ''),
      );
      return out.slice(0, limit);
    },
  };
}

export function defineAzureDevOpsDeployAdapter(
  transport: DeployTransport,
  gapPolicy?: GapPolicy,
  logger?: Logger,
): BaseDeployAdapter {
  return new BaseDeployAdapter(
    azureDevOpsDeployManifest,
    azureDevOpsDeployStatusMaps,
    transport,
    gapPolicy,
    logger,
  );
}
