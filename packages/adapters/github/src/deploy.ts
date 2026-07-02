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
import { Octokit } from 'octokit';
import { GITHUB_PROVIDER } from './provider.js';
import type { GithubTransportOptions } from './transport.js';

/** GitHub Environments + Deployments. Read-only (no create) in this slice. */
export const githubDeployManifest: DeployManifest = {
  provider: GITHUB_PROVIDER,
  deploy: { environments: true, deployments: true, canTrigger: false },
};

/** GitHub deployment-status `state` strings → normalized DeployStatus (no separate result axis). */
export const githubDeployStatusMaps: DeployStatusMaps = {
  status: {
    queued: 'pending',
    pending: 'pending',
    waiting: 'pending',
    in_progress: 'running',
    success: 'succeeded',
    failure: 'failed',
    error: 'failed',
    inactive: 'unknown',
  },
  result: {},
};

const DEFAULT_LIMIT = 20;

export function createGithubDeployTransport(options: GithubTransportOptions): DeployTransport {
  const { owner, repo, token } = options;
  const octokit = new Octokit({ auth: token });

  return {
    async listEnvironments(query: EnvironmentQuery): Promise<readonly Environment[]> {
      const { data } = await octokit.rest.repos.getAllEnvironments({
        owner,
        repo,
        per_page: query.limit ?? 100,
      });
      return (data.environments ?? []).map((e) => ({
        id: String(e.id),
        name: e.name,
        url: e.html_url,
      }));
    },

    async listDeployments(query: DeploymentQuery): Promise<readonly NativeDeployment[]> {
      const { data } = await octokit.rest.repos.listDeployments({
        owner,
        repo,
        ...(query.environment !== undefined ? { environment: query.environment } : {}),
        per_page: query.limit ?? DEFAULT_LIMIT,
      });
      // GitHub keeps a deployment's status separate; fetch the latest status per deployment in
      // PARALLEL (bounded by the page size) so the list isn't N sequential blocking round-trips.
      return Promise.all(
        data.map(async (d) => {
          const statuses = await octokit.rest.repos.listDeploymentStatuses({
            owner,
            repo,
            deployment_id: d.id,
            per_page: 1,
          });
          const latest = statuses.data[0];
          return {
            id: String(d.id),
            environment: typeof d.environment === 'string' ? d.environment : '',
            ...(latest !== undefined ? { status: latest.state } : {}),
            ref: typeof d.ref === 'string' ? d.ref : undefined,
            sha: d.sha,
            ...(typeof d.created_at === 'string' ? { createdAt: d.created_at } : {}),
            // The deployment's own updated_at is its finish time — not the status record's created_at.
            ...(typeof d.updated_at === 'string' ? { finishedAt: d.updated_at } : {}),
          };
        }),
      );
    },
  };
}

export function defineGithubDeployAdapter(
  transport: DeployTransport,
  gapPolicy?: GapPolicy,
  logger?: Logger,
): BaseDeployAdapter {
  return new BaseDeployAdapter(
    githubDeployManifest,
    githubDeployStatusMaps,
    transport,
    gapPolicy,
    logger,
  );
}
