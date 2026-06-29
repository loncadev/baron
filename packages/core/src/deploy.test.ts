import { describe, expect, it } from 'vitest';
import {
  BaseDeployAdapter,
  type DeployManifest,
  type DeployStatusMaps,
  type DeployTransport,
  type NativeDeployment,
} from './deploy.js';
import { CapabilityGapError } from './errors.js';
import { RecordingLogger } from './logger.js';

const statusMaps: DeployStatusMaps = {
  status: { InProgress: 'running', queued: 'pending' },
  result: { Succeeded: 'succeeded', Failed: 'failed', Canceled: 'canceled' },
};

const full: DeployManifest = {
  provider: 'fake',
  deploy: { environments: true, deployments: true, canTrigger: false },
};

function transportWith(deployments: NativeDeployment[]): DeployTransport {
  return {
    async listEnvironments() {
      return [{ id: 'e1', name: 'prod', url: 'mem://env/prod' }];
    },
    async listDeployments() {
      return deployments;
    },
  };
}

const dep = (id: string, status?: string, result?: string): NativeDeployment => ({
  id,
  environment: 'prod',
  ...(status !== undefined ? { status } : {}),
  ...(result !== undefined ? { result } : {}),
});

describe('BaseDeployAdapter', () => {
  it('lists environments', async () => {
    const adapter = new BaseDeployAdapter(full, statusMaps, transportWith([]));
    const envs = await adapter.environments();
    expect(envs[0]?.name).toBe('prod');
  });

  it('normalizes a finished deployment by result and an in-flight one by status', async () => {
    const adapter = new BaseDeployAdapter(
      full,
      statusMaps,
      transportWith([dep('1', undefined, 'Succeeded'), dep('2', 'InProgress')]),
    );
    const deps = await adapter.deployments();
    expect(deps[0]?.status).toBe('succeeded');
    expect(deps[0]?.nativeStatus).toBe('Succeeded');
    expect(deps[1]?.status).toBe('running');
  });

  it('falls back to unknown (never silent) for an unmapped native value', async () => {
    const adapter = new BaseDeployAdapter(full, statusMaps, transportWith([dep('1', 'Mystery')]));
    const [d] = await adapter.deployments();
    expect(d?.status).toBe('unknown');
    expect(d?.nativeStatus).toBe('Mystery');
  });

  it('errors when a capability is unsupported under the strict default policy (never silent)', async () => {
    const noEnv: DeployManifest = {
      ...full,
      deploy: { ...full.deploy, environments: false },
    };
    const adapter = new BaseDeployAdapter(noEnv, statusMaps, transportWith([]));
    await expect(adapter.environments()).rejects.toBeInstanceOf(CapabilityGapError);
  });

  it('degrades and warns when a capability is unsupported but the policy allows it', async () => {
    const log = new RecordingLogger();
    const noDeploys: DeployManifest = {
      ...full,
      deploy: { ...full.deploy, deployments: false },
    };
    const adapter = new BaseDeployAdapter(
      noDeploys,
      statusMaps,
      transportWith([dep('1', undefined, 'Succeeded')]),
      { deployments: { kind: 'degrade' } },
      log,
    );
    const deps = await adapter.deployments();
    expect(deps[0]?.status).toBe('succeeded');
    expect(log.entries.some((e) => e.level === 'warn')).toBe(true);
  });
});
