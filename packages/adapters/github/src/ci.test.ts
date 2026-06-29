import { createMemoryCiTransport } from '@baron/conformance';
import type { NativeRun } from '@baron/core';
import { describe, expect, it } from 'vitest';
import { defineGithubCiAdapter } from './ci.js';

const run = (id: string, status: string, result?: string): NativeRun => ({
  id,
  pipelineId: 'w1',
  status,
  ...(result !== undefined ? { result } : {}),
});

describe('github ci status maps', () => {
  it('maps GitHub Actions status/conclusion onto the normalized RunStatus vocabulary', async () => {
    // Exercises the whole RunStatus union, including skipped + waiting which the Azure adapter never
    // produces — proving the semantic layer is genuinely cross-provider.
    const adapter = defineGithubCiAdapter(
      createMemoryCiTransport({
        runs: [
          run('1', 'completed', 'success'),
          run('2', 'completed', 'failure'),
          run('3', 'completed', 'cancelled'),
          run('4', 'completed', 'skipped'),
          run('5', 'completed', 'timed_out'),
          run('6', 'completed', 'action_required'),
          run('7', 'in_progress'),
          run('8', 'queued'),
          run('9', 'waiting'),
        ],
      }),
    );
    const byId = Object.fromEntries((await adapter.runs()).map((r) => [r.id, r.status]));
    expect(byId).toEqual({
      '1': 'succeeded',
      '2': 'failed',
      '3': 'canceled',
      '4': 'skipped',
      '5': 'failed',
      '6': 'waiting',
      '7': 'running',
      '8': 'queued',
      '9': 'waiting',
    });
  });
});
