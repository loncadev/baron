import type {
  CiTransport,
  LogOptions,
  NativeLog,
  NativeRun,
  NativeRunDetail,
  NativeTriggerResult,
  Pipeline,
  PipelineQuery,
  RunQuery,
  TriggerInput,
} from '@lonca/baron-core';

export interface MemoryCiOptions {
  readonly pipelines?: readonly Pipeline[];
  readonly runs?: readonly NativeRun[];
  readonly log?: string;
}

const DEFAULT_PIPELINES: readonly Pipeline[] = [{ id: 'p1', name: 'CI', url: 'mem://pipeline/p1' }];

// Defaults use Azure-shaped native values (status + result) so the slice-1 adapter's status maps
// exercise real normalization; other adapters can pass their own natives via options.
const DEFAULT_RUNS: readonly NativeRun[] = [
  {
    id: '1',
    pipelineId: 'p1',
    pipelineName: 'CI',
    status: 'completed',
    result: 'succeeded',
    branch: 'main',
    number: '1',
    url: 'mem://run/1',
  },
  {
    id: '2',
    pipelineId: 'p1',
    pipelineName: 'CI',
    status: 'inProgress',
    branch: 'main',
    number: '2',
    url: 'mem://run/2',
  },
];

/**
 * In-memory stand-in for a `ci` transport. Deterministic and network-free so the ci conformance
 * suite (and port/MCP logic) run without a live CI provider; the live transports are validated
 * separately by gated smoke tests.
 */
export function createMemoryCiTransport(options: MemoryCiOptions = {}): CiTransport {
  const pipelines = options.pipelines ?? DEFAULT_PIPELINES;
  const runs = options.runs ?? DEFAULT_RUNS;
  const log = options.log ?? 'mem log line 1\nmem log line 2';

  return {
    async listPipelines(query: PipelineQuery): Promise<readonly Pipeline[]> {
      return query.limit !== undefined ? pipelines.slice(0, query.limit) : pipelines;
    },

    async listRuns(query: RunQuery): Promise<readonly NativeRun[]> {
      let result = runs;
      if (query.pipelineId !== undefined) {
        result = result.filter((r) => r.pipelineId === query.pipelineId);
      }
      if (query.branch !== undefined) {
        result = result.filter((r) => r.branch === query.branch);
      }
      return query.limit !== undefined ? result.slice(0, query.limit) : result;
    },

    async getRun(id: string): Promise<NativeRunDetail> {
      const base = runs.find((r) => r.id === id) ?? runs[0];
      return {
        ...(base as NativeRun),
        stages: [{ name: 'build', status: 'completed', result: 'succeeded' }],
      };
    },

    async fetchLogs(_runId: string, _options: LogOptions): Promise<NativeLog> {
      return { content: log, truncated: false };
    },

    async triggerRun(input: TriggerInput): Promise<NativeTriggerResult> {
      return {
        accepted: true,
        run: { id: 'mem-triggered', pipelineId: input.pipelineId, status: 'inProgress' },
      };
    },

    async cancelRun(runId: string): Promise<NativeRun> {
      return { id: runId, pipelineId: 'p1', status: 'completed', result: 'canceled' };
    },
  };
}
