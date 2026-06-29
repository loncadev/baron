import { createMemoryCiTransport } from '@baron/conformance';
import type { NativeRun } from '@baron/core';
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
});
