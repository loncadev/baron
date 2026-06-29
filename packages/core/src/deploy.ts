import { type Logger, silentLogger } from './logger.js';
import { type GapPolicy, resolveCapabilityGap } from './policy.js';

/**
 * Normalized deployment status — the semantic layer for "is my deploy out?", the deploy analogue of
 * the CI {@link './ci.js'.RunStatus}. A deployment is described by a phase and/or a result; both
 * collapse onto this single vocabulary so recipes speak provider-agnostic deploy statuses.
 */
export const DEPLOY_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'canceled',
  'skipped',
  'unknown',
] as const;
export type DeployStatus = (typeof DEPLOY_STATUSES)[number];

export function isDeployStatus(value: string): value is DeployStatus {
  return (DEPLOY_STATUSES as readonly string[]).includes(value);
}

/** What a `deploy` adapter supports; the core applies the gap policy for anything `false`. */
export interface DeployCapabilities {
  /** Named environments can be listed. */
  environments: boolean;
  /** Deployment history can be listed. */
  deployments: boolean;
  /** Deployments can be triggered/created (write — false for the read-only slice). */
  canTrigger: boolean;
}
export type DeployCapabilityName = keyof DeployCapabilities;

export interface DeployManifest {
  provider: string;
  deploy: DeployCapabilities;
}

/**
 * Adapter-provided maps from a provider's fixed native enums to {@link DeployStatus}. Vendor-fixed
 * (like CI statuses), so they are adapter knowledge, not user config — no `baron init` step.
 */
export interface DeployStatusMaps {
  readonly status: Readonly<Record<string, DeployStatus>>;
  readonly result: Readonly<Record<string, DeployStatus>>;
}

/** A normalized deployment environment (e.g. 'dev', 'prod'). */
export interface Environment {
  readonly id: string;
  readonly name: string;
  readonly url?: string | undefined;
}

/** A normalized deployment record, independent of the backing provider. */
export interface Deployment {
  readonly id: string;
  readonly environment: string;
  readonly status: DeployStatus;
  /** The raw provider value(s) the status was resolved from — never silent. */
  readonly nativeStatus: string;
  readonly ref?: string | undefined;
  readonly sha?: string | undefined;
  readonly url?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly finishedAt?: string | undefined;
}

/** Native deployment the transport returns — status/result are still the raw provider enums. */
export interface NativeDeployment {
  readonly id: string;
  readonly environment: string;
  readonly status?: string | undefined;
  readonly result?: string | undefined;
  readonly ref?: string | undefined;
  readonly sha?: string | undefined;
  readonly url?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly finishedAt?: string | undefined;
}

export interface EnvironmentQuery {
  readonly limit?: number | undefined;
}

export interface DeploymentQuery {
  /** Restrict to one environment (provider-native id/name). */
  readonly environment?: string | undefined;
  readonly limit?: number | undefined;
}

/** The thin, provider-specific transport a `deploy` adapter delegates I/O to (read-only slice). */
export interface DeployTransport {
  listEnvironments(query: EnvironmentQuery): Promise<readonly Environment[]>;
  listDeployments(query: DeploymentQuery): Promise<readonly NativeDeployment[]>;
}

/** The normalized read surface the core exposes for the `deploy` port. */
export interface DeployPort {
  readonly manifest: DeployManifest;
  environments(query?: EnvironmentQuery): Promise<readonly Environment[]>;
  deployments(query?: DeploymentQuery): Promise<readonly Deployment[]>;
}

/**
 * Provider-agnostic implementation of the `deploy` primitives. Collapses a deployment's native
 * phase/result onto a {@link DeployStatus} via the adapter's {@link DeployStatusMaps}, and negotiates
 * capability gaps. A concrete adapter supplies only a {@link DeployManifest}, status maps, and a
 * {@link DeployTransport}.
 */
export class BaseDeployAdapter implements DeployPort {
  constructor(
    readonly manifest: DeployManifest,
    private readonly statusMaps: DeployStatusMaps,
    private readonly transport: DeployTransport,
    private readonly gapPolicy: GapPolicy = {},
    private readonly logger: Logger = silentLogger,
  ) {}

  private normalize(
    status?: string,
    result?: string,
  ): { status: DeployStatus; nativeStatus: string } {
    const hasResult = result !== undefined && result.length > 0;
    const hasStatus = status !== undefined && status.length > 0;
    const nativeStatus = hasResult
      ? hasStatus
        ? `${status}/${result}`
        : result
      : hasStatus
        ? status
        : '';
    const resolved =
      (hasResult ? this.statusMaps.result[result] : undefined) ??
      (hasStatus ? this.statusMaps.status[status] : undefined) ??
      'unknown';
    return { status: resolved, nativeStatus };
  }

  async environments(query: EnvironmentQuery = {}): Promise<readonly Environment[]> {
    if (!this.manifest.deploy.environments) {
      resolveCapabilityGap(
        false,
        'environments',
        this.manifest.provider,
        this.gapPolicy,
        this.logger,
      );
    }
    return this.transport.listEnvironments(query);
  }

  async deployments(query: DeploymentQuery = {}): Promise<readonly Deployment[]> {
    if (!this.manifest.deploy.deployments) {
      resolveCapabilityGap(
        false,
        'deployments',
        this.manifest.provider,
        this.gapPolicy,
        this.logger,
      );
    }
    const native = await this.transport.listDeployments(query);
    return native.map((d) => {
      const { status, nativeStatus } = this.normalize(d.status, d.result);
      return {
        id: d.id,
        environment: d.environment,
        status,
        nativeStatus,
        ref: d.ref,
        sha: d.sha,
        url: d.url,
        createdAt: d.createdAt,
        finishedAt: d.finishedAt,
      };
    });
  }
}
