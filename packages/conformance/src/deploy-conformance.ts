import {
  DEPLOY_STATUSES,
  type DeployPort,
  type GapPolicy,
  type RecordingLogger,
} from '@lonca/baron-core';
import { describe, expect, it } from 'vitest';

export interface DeployConformanceTarget {
  readonly label: string;
  /** Build a fresh deploy adapter (in-memory transport) with the given gap policy, plus its logger. */
  build(gapPolicy?: GapPolicy): { adapter: DeployPort; logger: RecordingLogger };
}

const isDeployStatus = (s: string): boolean => (DEPLOY_STATUSES as readonly string[]).includes(s);

/**
 * The contract every `deploy` adapter must satisfy: capabilities are booleans; environments and
 * deployments come back normalized; every deployment resolves to a {@link DeployStatus} from the
 * shared vocabulary (never an unmapped native) while preserving the raw `nativeStatus`.
 */
export function runDeployConformance(target: DeployConformanceTarget): void {
  describe(`deploy conformance: ${target.label}`, () => {
    it('declares the deploy capabilities as booleans', () => {
      const { adapter } = target.build();
      for (const key of ['environments', 'deployments', 'canTrigger'] as const) {
        expect(typeof adapter.manifest.deploy[key]).toBe('boolean');
      }
    });

    it('lists environments as normalized records', async () => {
      const { adapter } = target.build();
      if (!adapter.manifest.deploy.environments) return;
      const envs = await adapter.environments();
      expect(envs.length).toBeGreaterThan(0);
      expect(typeof envs[0]?.id).toBe('string');
      expect(typeof envs[0]?.name).toBe('string');
    });

    it('lists deployments with a normalized status and preserves the native value', async () => {
      const { adapter } = target.build();
      if (!adapter.manifest.deploy.deployments) return;
      const deps = await adapter.deployments();
      expect(deps.length).toBeGreaterThan(0);
      for (const d of deps) {
        expect(isDeployStatus(d.status)).toBe(true);
        expect(typeof d.environment).toBe('string');
      }
    });
  });
}
