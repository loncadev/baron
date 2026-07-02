import type {
  DeployTransport,
  DeploymentQuery,
  Environment,
  EnvironmentQuery,
  NativeDeployment,
} from '@lonca/baron-core';

export interface MemoryDeployOptions {
  readonly environments?: readonly Environment[];
  readonly deployments?: readonly NativeDeployment[];
}

const DEFAULT_ENVIRONMENTS: readonly Environment[] = [
  { id: 'e1', name: 'dev', url: 'mem://env/dev' },
  { id: 'e2', name: 'prod', url: 'mem://env/prod' },
];

// Azure-shaped natives by default so the slice adapter exercises real normalization.
const DEFAULT_DEPLOYMENTS: readonly NativeDeployment[] = [
  { id: '1', environment: 'prod', result: 'Succeeded', ref: 'release', sha: 'abc123' },
  { id: '2', environment: 'dev', status: 'InProgress', ref: 'dev' },
];

/**
 * In-memory stand-in for a `deploy` transport. Deterministic and network-free so the deploy
 * conformance suite (and port/MCP logic) run without a live deployment provider.
 */
export function createMemoryDeployTransport(options: MemoryDeployOptions = {}): DeployTransport {
  const environments = options.environments ?? DEFAULT_ENVIRONMENTS;
  const deployments = options.deployments ?? DEFAULT_DEPLOYMENTS;

  return {
    async listEnvironments(query: EnvironmentQuery): Promise<readonly Environment[]> {
      return query.limit !== undefined ? environments.slice(0, query.limit) : environments;
    },

    async listDeployments(query: DeploymentQuery): Promise<readonly NativeDeployment[]> {
      let result = deployments;
      if (query.environment !== undefined) {
        result = result.filter((d) => d.environment === query.environment);
      }
      return query.limit !== undefined ? result.slice(0, query.limit) : result;
    },
  };
}
