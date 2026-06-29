import { describe, expect, it } from 'vitest';
import {
  BaseCiAdapter,
  type CiManifest,
  type CiStatusMaps,
  type CiTransport,
  type NativeRun,
} from './ci.js';
import { CapabilityGapError } from './errors.js';
import { RecordingLogger } from './logger.js';

const statusMaps: CiStatusMaps = {
  status: { queued: 'queued', inProgress: 'running' },
  result: { succeeded: 'succeeded', failed: 'failed', canceled: 'canceled' },
};

const fullManifest: CiManifest = {
  provider: 'fake',
  ci: {
    canTrigger: true,
    canCancel: true,
    hasStages: true,
    hasApprovalGates: false,
    providesLogs: true,
    hasArtifacts: false,
  },
};

function transportWith(runs: NativeRun[], log = 'line1\nline2'): CiTransport {
  return {
    async listPipelines() {
      return [{ id: 'p1', name: 'CI' }];
    },
    async listRuns() {
      return runs;
    },
    async getRun(id) {
      const base = runs.find((r) => r.id === id) ?? runs[0];
      return {
        ...(base as NativeRun),
        stages: [{ name: 'build', status: 'completed', result: 'succeeded' }],
      };
    },
    async fetchLogs() {
      return { content: log, truncated: true };
    },
    async triggerRun(input) {
      return { accepted: true, run: { id: 'new', pipelineId: input.pipelineId, status: 'queued' } };
    },
    async cancelRun(id) {
      return { id, pipelineId: 'p1', status: 'completed', result: 'canceled' };
    },
  };
}

const run = (id: string, status: string, result?: string): NativeRun => ({
  id,
  pipelineId: 'p1',
  status,
  ...(result !== undefined ? { result } : {}),
});

describe('BaseCiAdapter run-status normalization', () => {
  it('uses the result axis for a finished run', async () => {
    const adapter = new BaseCiAdapter(
      fullManifest,
      statusMaps,
      transportWith([run('1', 'completed', 'succeeded'), run('2', 'completed', 'failed')]),
    );
    const runs = await adapter.runs();
    expect(runs[0]?.status).toBe('succeeded');
    expect(runs[0]?.nativeStatus).toBe('completed/succeeded');
    expect(runs[1]?.status).toBe('failed');
  });

  it('uses the phase axis for an in-flight run', async () => {
    const adapter = new BaseCiAdapter(
      fullManifest,
      statusMaps,
      transportWith([run('1', 'inProgress'), run('2', 'queued')]),
    );
    const runs = await adapter.runs();
    expect(runs[0]?.status).toBe('running');
    expect(runs[1]?.status).toBe('queued');
  });

  it('falls back to unknown (never silent) but preserves the native value', async () => {
    const adapter = new BaseCiAdapter(
      fullManifest,
      statusMaps,
      transportWith([run('1', 'postponed', 'mysteryResult')]),
    );
    const [r] = await adapter.runs();
    expect(r?.status).toBe('unknown');
    expect(r?.nativeStatus).toBe('postponed/mysteryResult');
  });

  it('normalizes stage statuses in run detail', async () => {
    const adapter = new BaseCiAdapter(
      fullManifest,
      statusMaps,
      transportWith([run('1', 'completed', 'succeeded')]),
    );
    const detail = await adapter.run('1');
    expect(detail.stages[0]?.name).toBe('build');
    expect(detail.stages[0]?.status).toBe('succeeded');
  });
});

describe('BaseCiAdapter logs capability gap', () => {
  const noLogs: CiManifest = { ...fullManifest, ci: { ...fullManifest.ci, providesLogs: false } };

  it('returns a size-aware log tail when supported', async () => {
    const adapter = new BaseCiAdapter(
      fullManifest,
      statusMaps,
      transportWith([run('1', 'queued')]),
    );
    const chunk = await adapter.logs('1');
    expect(chunk.content).toContain('line1');
    expect(chunk.truncated).toBe(true);
  });

  it('errors on logs under the strict default policy when unsupported (never silent)', async () => {
    const adapter = new BaseCiAdapter(noLogs, statusMaps, transportWith([run('1', 'queued')]));
    await expect(adapter.logs('1')).rejects.toBeInstanceOf(CapabilityGapError);
  });

  it('degrades and warns when logs are unsupported but the policy allows it', async () => {
    const log = new RecordingLogger();
    const adapter = new BaseCiAdapter(
      noLogs,
      statusMaps,
      transportWith([run('1', 'queued')]),
      { providesLogs: { kind: 'degrade' } },
      log,
    );
    const chunk = await adapter.logs('1');
    expect(chunk.runId).toBe('1');
    expect(log.entries.some((e) => e.level === 'warn')).toBe(true);
  });
});

describe('BaseCiAdapter trigger / cancel', () => {
  const noWrite: CiManifest = {
    ...fullManifest,
    ci: { ...fullManifest.ci, canTrigger: false, canCancel: false },
  };

  it('triggers a run and normalizes the returned run', async () => {
    const adapter = new BaseCiAdapter(
      fullManifest,
      statusMaps,
      transportWith([run('1', 'queued')]),
    );
    const result = await adapter.trigger({ pipelineId: 'p1' });
    expect(result.accepted).toBe(true);
    expect(result.run?.status).toBe('queued');
  });

  it('cancels a run and normalizes its status', async () => {
    const adapter = new BaseCiAdapter(
      fullManifest,
      statusMaps,
      transportWith([run('1', 'queued')]),
    );
    const cancelled = await adapter.cancel('1');
    expect(cancelled.status).toBe('canceled');
  });

  it('errors on trigger/cancel under the strict default policy when unsupported (never silent)', async () => {
    const adapter = new BaseCiAdapter(noWrite, statusMaps, transportWith([run('1', 'queued')]));
    await expect(adapter.trigger({ pipelineId: 'p1' })).rejects.toBeInstanceOf(CapabilityGapError);
    await expect(adapter.cancel('1')).rejects.toBeInstanceOf(CapabilityGapError);
  });
});
