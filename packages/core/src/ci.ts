import { type Logger, silentLogger } from './logger.js';
import { type GapPolicy, resolveCapabilityGap } from './policy.js';

/**
 * Normalized CI run status — the semantic layer for build/run state, the CI analogue of the issues
 * workflow roles. Providers describe a run on two native axes (a lifecycle *phase* and, once finished,
 * a *result*); both collapse onto this single vocabulary so recipes speak provider-agnostic statuses.
 */
export const RUN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
  'skipped',
  'waiting',
  'unknown',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export function isRunStatus(value: string): value is RunStatus {
  return (RUN_STATUSES as readonly string[]).includes(value);
}

/**
 * What a `ci` adapter supports. The core consults this before an operation and applies the gap policy
 * for anything `false` (e.g. `logs` on a provider with `providesLogs: false`) — never silent.
 */
export interface CiCapabilities {
  canTrigger: boolean;
  canCancel: boolean;
  hasStages: boolean;
  hasApprovalGates: boolean;
  providesLogs: boolean;
  hasArtifacts: boolean;
}
export type CiCapabilityName = keyof CiCapabilities;

/** Self-description a `ci` adapter exposes so the core can negotiate gaps. */
export interface CiManifest {
  provider: string;
  ci: CiCapabilities;
}

/**
 * Adapter-provided maps from a provider's fixed native enums to {@link RunStatus}. Unlike the issues
 * role map (user-configured, because issue states are user-defined), CI statuses are **vendor-fixed**,
 * so these maps are provider knowledge the adapter supplies — there is no `baron init` step for them.
 */
export interface CiStatusMaps {
  /** Native lifecycle/phase value (Azure `Build.status`, GitHub `run.status`) -> RunStatus. */
  readonly status: Readonly<Record<string, RunStatus>>;
  /** Native result/conclusion value (Azure `Build.result`, GitHub `run.conclusion`) -> RunStatus. */
  readonly result: Readonly<Record<string, RunStatus>>;
}

/** A normalized pipeline definition. */
export interface Pipeline {
  readonly id: string;
  readonly name: string;
  readonly url?: string | undefined;
}

/** A normalized CI run, independent of the backing provider. */
export interface Run {
  readonly id: string;
  readonly pipelineId: string;
  readonly pipelineName?: string | undefined;
  readonly status: RunStatus;
  /** The raw provider value(s) the status was resolved from (phase[/result]) — never silent. */
  readonly nativeStatus: string;
  readonly branch?: string | undefined;
  /** Human-facing run number where the provider has one. */
  readonly number?: string | undefined;
  readonly url?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly finishedAt?: string | undefined;
}

/** A stage/job within a run (populated only when the provider `hasStages`). */
export interface RunStage {
  readonly name: string;
  readonly status: RunStatus;
  readonly nativeStatus: string;
}

export interface RunDetail extends Run {
  readonly stages: readonly RunStage[];
}

/** A size-aware log slice: a lean tail by default so a huge log can't overflow the caller's context. */
export interface LogChunk {
  readonly runId: string;
  readonly content: string;
  /** True when earlier log content was omitted (only the tail was returned). */
  readonly truncated: boolean;
}

export interface PipelineQuery {
  readonly limit?: number | undefined;
}

export interface RunQuery {
  readonly pipelineId?: string | undefined;
  readonly branch?: string | undefined;
  readonly status?: RunStatus | undefined;
  readonly limit?: number | undefined;
}

export interface LogOptions {
  /** Max lines to return from the tail; the adapter caps a large log to this. */
  readonly tailLines?: number | undefined;
}

/** Input to `ci.trigger`. */
export interface TriggerInput {
  readonly pipelineId: string;
  /** Branch/tag to run on; defaults to the provider's default branch when omitted. */
  readonly ref?: string | undefined;
  /** Pipeline variables / workflow inputs. */
  readonly variables?: Readonly<Record<string, string>> | undefined;
}

/**
 * Result of `ci.trigger`. `run` is present when the provider returns the created run synchronously
 * (Azure queueBuild); it is absent for a fire-and-forget dispatch that returns no run id (GitHub
 * `workflow_dispatch`) — modelled honestly rather than fabricating a run.
 */
export interface TriggerResult {
  readonly accepted: boolean;
  readonly run?: Run | undefined;
}

/** Native run the transport returns — status/result are still the raw provider enums. */
export interface NativeRun {
  readonly id: string;
  readonly pipelineId: string;
  readonly pipelineName?: string | undefined;
  /** Native lifecycle/phase (e.g. 'completed', 'inProgress', 'queued'). */
  readonly status: string;
  /** Native result/conclusion once the run has finished (e.g. 'succeeded', 'failure'). */
  readonly result?: string | undefined;
  readonly branch?: string | undefined;
  readonly number?: string | undefined;
  readonly url?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly finishedAt?: string | undefined;
}

export interface NativeRunStage {
  readonly name: string;
  readonly status: string;
  readonly result?: string | undefined;
}

export interface NativeRunDetail extends NativeRun {
  readonly stages: readonly NativeRunStage[];
}

export interface NativeLog {
  readonly content: string;
  readonly truncated: boolean;
}

/** Native trigger result the transport returns (run still carries raw provider status). */
export interface NativeTriggerResult {
  readonly accepted: boolean;
  readonly run?: NativeRun | undefined;
}

/**
 * The thin, provider-specific transport a `ci` adapter delegates I/O to. Real implementations call
 * the vendor SDK; the conformance suite passes an in-memory fake — the same separation the other
 * ports use.
 */
export interface CiTransport {
  listPipelines(query: PipelineQuery): Promise<readonly Pipeline[]>;
  listRuns(query: RunQuery): Promise<readonly NativeRun[]>;
  getRun(id: string): Promise<NativeRunDetail>;
  fetchLogs(runId: string, options: LogOptions): Promise<NativeLog>;
  triggerRun(input: TriggerInput): Promise<NativeTriggerResult>;
  cancelRun(runId: string): Promise<NativeRun>;
}

/** The normalized primitive surface the core exposes for the `ci` port. */
export interface CiPort {
  readonly manifest: CiManifest;
  pipelines(query?: PipelineQuery): Promise<readonly Pipeline[]>;
  runs(query?: RunQuery): Promise<readonly Run[]>;
  run(id: string): Promise<RunDetail>;
  logs(runId: string, options?: LogOptions): Promise<LogChunk>;
  trigger(input: TriggerInput): Promise<TriggerResult>;
  cancel(runId: string): Promise<Run>;
}

/**
 * Provider-agnostic implementation of the `ci` primitives. It owns the one piece of cross-provider
 * logic — collapsing a run's two native axes (phase + result) onto a {@link RunStatus} via the
 * adapter's {@link CiStatusMaps} — and the gap negotiation; a concrete adapter supplies only a
 * {@link CiManifest}, its status maps, and a {@link CiTransport}.
 */
export class BaseCiAdapter implements CiPort {
  constructor(
    readonly manifest: CiManifest,
    private readonly statusMaps: CiStatusMaps,
    private readonly transport: CiTransport,
    private readonly gapPolicy: GapPolicy = {},
    private readonly logger: Logger = silentLogger,
  ) {}

  /**
   * A finished run carries a result/conclusion that decides success vs failure; an in-flight run is
   * described only by its phase. Prefer the result map, fall back to the phase map, and to 'unknown'
   * (never silent) — always keeping the raw value(s) in `nativeStatus`.
   */
  private normalize(status: string, result?: string): { status: RunStatus; nativeStatus: string } {
    const hasResult = result !== undefined && result.length > 0;
    const nativeStatus = hasResult ? `${status}/${result}` : status;
    const resolved =
      (hasResult ? this.statusMaps.result[result] : undefined) ??
      this.statusMaps.status[status] ??
      'unknown';
    return { status: resolved, nativeStatus };
  }

  private toRun(n: NativeRun): Run {
    const { status, nativeStatus } = this.normalize(n.status, n.result);
    return {
      id: n.id,
      pipelineId: n.pipelineId,
      pipelineName: n.pipelineName,
      status,
      nativeStatus,
      branch: n.branch,
      number: n.number,
      url: n.url,
      createdAt: n.createdAt,
      finishedAt: n.finishedAt,
    };
  }

  async pipelines(query: PipelineQuery = {}): Promise<readonly Pipeline[]> {
    return this.transport.listPipelines(query);
  }

  async runs(query: RunQuery = {}): Promise<readonly Run[]> {
    const native = await this.transport.listRuns(query);
    return native.map((n) => this.toRun(n));
  }

  async run(id: string): Promise<RunDetail> {
    const detail = await this.transport.getRun(id);
    const stages = detail.stages.map((s) => {
      const { status, nativeStatus } = this.normalize(s.status, s.result);
      return { name: s.name, status, nativeStatus };
    });
    return { ...this.toRun(detail), stages };
  }

  async logs(runId: string, options: LogOptions = {}): Promise<LogChunk> {
    if (!this.manifest.ci.providesLogs) {
      // Provider can't supply logs: negotiate per policy rather than returning a confusing empty log.
      resolveCapabilityGap(
        false,
        'providesLogs',
        this.manifest.provider,
        this.gapPolicy,
        this.logger,
      );
    }
    const native = await this.transport.fetchLogs(runId, options);
    return { runId, content: native.content, truncated: native.truncated };
  }

  async trigger(input: TriggerInput): Promise<TriggerResult> {
    if (!this.manifest.ci.canTrigger) {
      resolveCapabilityGap(
        false,
        'canTrigger',
        this.manifest.provider,
        this.gapPolicy,
        this.logger,
      );
    }
    const native = await this.transport.triggerRun(input);
    return { accepted: native.accepted, run: native.run ? this.toRun(native.run) : undefined };
  }

  async cancel(runId: string): Promise<Run> {
    if (!this.manifest.ci.canCancel) {
      resolveCapabilityGap(false, 'canCancel', this.manifest.provider, this.gapPolicy, this.logger);
    }
    return this.toRun(await this.transport.cancelRun(runId));
  }
}
