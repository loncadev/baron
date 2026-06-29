import { createMemoryDeployTransport } from '@baron/conformance';
import { describe, expect, it } from 'vitest';
import { defineGithubDeployAdapter } from './deploy.js';

describe('github deploy status maps', () => {
  it('maps GitHub deployment-status states onto the normalized DeployStatus vocabulary', async () => {
    const adapter = defineGithubDeployAdapter(
      createMemoryDeployTransport({
        deployments: [
          { id: '1', environment: 'prod', status: 'success' },
          { id: '2', environment: 'prod', status: 'failure' },
          { id: '3', environment: 'prod', status: 'error' },
          { id: '4', environment: 'prod', status: 'in_progress' },
          { id: '5', environment: 'prod', status: 'queued' },
          { id: '6', environment: 'prod', status: 'inactive' },
        ],
      }),
    );
    const byId = Object.fromEntries((await adapter.deployments()).map((d) => [d.id, d.status]));
    expect(byId).toEqual({
      '1': 'succeeded',
      '2': 'failed',
      '3': 'failed',
      '4': 'running',
      '5': 'pending',
      '6': 'unknown',
    });
  });
});
