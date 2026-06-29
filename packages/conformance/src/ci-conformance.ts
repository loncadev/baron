import { type CiPort, type GapPolicy, RUN_STATUSES, type RecordingLogger } from '@baron/core';
import { describe, expect, it } from 'vitest';

export interface CiConformanceTarget {
  readonly label: string;
  /** Build a fresh ci adapter (in-memory transport) with the given gap policy, plus its logger. */
  build(gapPolicy?: GapPolicy): { adapter: CiPort; logger: RecordingLogger };
}

const isRunStatus = (s: string): boolean => (RUN_STATUSES as readonly string[]).includes(s);

/**
 * The contract every `ci` adapter must satisfy. CI is uniform enough across providers that this
 * asserts the same shape for all of them — crucially that every run resolves to a {@link RunStatus}
 * from the shared vocabulary (never an unmapped native value) while preserving the raw `nativeStatus`.
 * Provider-specific status-map correctness is unit-tested in each adapter; the gap branch is covered
 * in core where a provider lacking a capability can be simulated.
 */
export function runCiConformance(target: CiConformanceTarget): void {
  describe(`ci conformance: ${target.label}`, () => {
    it('declares the ci capabilities as booleans', () => {
      const { adapter } = target.build();
      for (const key of [
        'canTrigger',
        'canCancel',
        'hasStages',
        'hasApprovalGates',
        'providesLogs',
        'hasArtifacts',
      ] as const) {
        expect(typeof adapter.manifest.ci[key]).toBe('boolean');
      }
    });

    it('lists pipelines as normalized definitions', async () => {
      const { adapter } = target.build();
      const pipelines = await adapter.pipelines();
      expect(pipelines.length).toBeGreaterThan(0);
      expect(typeof pipelines[0]?.id).toBe('string');
      expect(typeof pipelines[0]?.name).toBe('string');
    });

    it('lists runs with a normalized RunStatus and preserves the native value', async () => {
      const { adapter } = target.build();
      const runs = await adapter.runs();
      expect(runs.length).toBeGreaterThan(0);
      for (const run of runs) {
        expect(isRunStatus(run.status)).toBe(true);
        expect(run.nativeStatus.length).toBeGreaterThan(0);
      }
    });

    it('returns run detail with normalized stage statuses', async () => {
      const { adapter } = target.build();
      const runs = await adapter.runs();
      const id = runs[0]?.id as string;
      const detail = await adapter.run(id);
      expect(isRunStatus(detail.status)).toBe(true);
      for (const stage of detail.stages) {
        expect(isRunStatus(stage.status)).toBe(true);
      }
    });

    it('returns a size-aware log chunk when logs are supported', async () => {
      const { adapter } = target.build();
      if (!adapter.manifest.ci.providesLogs) return;
      const runs = await adapter.runs();
      const chunk = await adapter.logs(runs[0]?.id as string);
      expect(typeof chunk.content).toBe('string');
      expect(typeof chunk.truncated).toBe('boolean');
    });
  });
}
