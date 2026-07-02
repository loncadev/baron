import { createMemoryDeployTransport } from '@lonca/baron-conformance';
import { describe, expect, it } from 'vitest';
import { defineAzureDevOpsDeployAdapter } from './deploy.js';

describe('azure-devops deploy status maps', () => {
  it('maps TaskResult (and in-flight) onto the normalized DeployStatus vocabulary', async () => {
    const adapter = defineAzureDevOpsDeployAdapter(
      createMemoryDeployTransport({
        deployments: [
          { id: '1', environment: 'prod', result: 'Succeeded' },
          { id: '2', environment: 'prod', result: 'Failed' },
          { id: '3', environment: 'prod', result: 'Canceled' },
          { id: '4', environment: 'prod', result: 'Skipped' },
          { id: '5', environment: 'prod', result: 'SucceededWithIssues' },
          { id: '6', environment: 'dev', status: 'InProgress' },
        ],
      }),
    );
    const byId = Object.fromEntries((await adapter.deployments()).map((d) => [d.id, d.status]));
    expect(byId).toEqual({
      '1': 'succeeded',
      '2': 'failed',
      '3': 'canceled',
      '4': 'skipped',
      '5': 'succeeded',
      '6': 'running',
    });
  });
});
