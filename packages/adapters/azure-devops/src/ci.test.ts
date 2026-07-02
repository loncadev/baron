import { createMemoryCiTransport } from '@lonca/baron-conformance';
import type { NativeRun } from '@lonca/baron-core';
import { describe, expect, it } from 'vitest';
import { defineAzureDevOpsCiAdapter } from './ci.js';

const run = (id: string, status: string, result?: string): NativeRun => ({
  id,
  pipelineId: 'p1',
  status,
  ...(result !== undefined ? { result } : {}),
});

describe('azure-devops ci status maps', () => {
  it('maps Azure build status/result onto the normalized RunStatus vocabulary', async () => {
    const adapter = defineAzureDevOpsCiAdapter(
      createMemoryCiTransport({
        runs: [
          run('1', 'Completed', 'Succeeded'),
          run('2', 'Completed', 'Failed'),
          run('3', 'Completed', 'PartiallySucceeded'),
          run('4', 'Completed', 'Canceled'),
          run('5', 'InProgress'),
          run('6', 'NotStarted'),
        ],
      }),
    );
    const byId = Object.fromEntries((await adapter.runs()).map((r) => [r.id, r.status]));
    expect(byId).toEqual({
      '1': 'succeeded',
      '2': 'failed',
      '3': 'failed',
      '4': 'canceled',
      '5': 'running',
      '6': 'queued',
    });
  });

  it('also normalizes the timeline (stage) enums, which share the same maps', async () => {
    // Stages come from the build timeline (TimelineRecordState / TaskResult); these merge into the
    // same status maps as the build axes, so the extra members must resolve too.
    const adapter = defineAzureDevOpsCiAdapter(
      createMemoryCiTransport({
        runs: [
          run('1', 'Completed', 'Skipped'),
          run('2', 'Completed', 'SucceededWithIssues'),
          run('3', 'Completed', 'Abandoned'),
          run('4', 'Pending'),
        ],
      }),
    );
    const byId = Object.fromEntries((await adapter.runs()).map((r) => [r.id, r.status]));
    expect(byId).toEqual({ '1': 'skipped', '2': 'failed', '3': 'canceled', '4': 'queued' });
  });
});
