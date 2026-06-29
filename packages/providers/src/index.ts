import {
  AZURE_DEVOPS_PROVIDER,
  azureDevOpsCiManifest,
  azureDevOpsCiStatusMaps,
  azureDevOpsManifest,
  azureDevOpsScmManifest,
  createAzureDevOpsCiTransport,
  createAzureDevOpsIntrospector,
  createAzureDevOpsScmTransport,
  createAzureDevOpsTransport,
  exampleAzureDevOpsLinkMap,
} from '@baron/adapter-azure-devops';
import {
  GITHUB_PROVIDER,
  createGithubCiTransport,
  createGithubIntrospector,
  createGithubScmTransport,
  createGithubTransport,
  exampleGithubLinkMap,
  githubCiManifest,
  githubCiStatusMaps,
  githubManifest,
  githubScmManifest,
} from '@baron/adapter-github';
import {
  SLACK_PROVIDER,
  createSlackNotifyTransport,
  slackNotifyManifest,
} from '@baron/adapter-slack';
import {
  BaronError,
  type BaronPolicyFile,
  BaseCiAdapter,
  BaseIssuesAdapter,
  BaseNotifyAdapter,
  BaseScmAdapter,
  type CapabilityManifest,
  type CiManifest,
  type CiPort,
  type CiStatusMaps,
  type CiTransport,
  type GapPolicy,
  type Introspector,
  type IssuesPort,
  type IssuesProviderConfig,
  type IssuesTransport,
  type LinkMap,
  type Logger,
  type NotifyManifest,
  type NotifyPort,
  type NotifyTransport,
  type ScmManifest,
  type ScmPort,
  type ScmTransport,
  parseGapPolicy,
  resolveIssuesConfig,
} from '@baron/core';
import {
  type NativeHttp,
  type NativeRequest,
  type NativeResponse,
  azureBasicAuth,
  runNativeRequest,
} from './native.js';

export * from './paths.js';
export * from './credentials.js';
export * from './native.js';

/** A read-only view of process environment (credentials live here, never in committed policy). */
export type Env = Record<string, string | undefined>;

/**
 * Everything Baron's entrypoints (CLI, MCP server) need to bind a provider id to live behavior: its
 * capability manifest, the env keys carrying its credentials (scaffolded into
 * `.baron/credentials.example`, never committed), and factories for the live transport + introspector.
 * This is shared infrastructure deliberately kept out of any single entrypoint so the CLI and the
 * MCP server depend on it rather than on each other.
 */
export interface ProviderDescriptor {
  readonly id: string;
  // A provider implements SOME ports, not all (e.g. Slack is notify-only) — every port group is
  // optional, and the matching build*Port throws *_UNSUPPORTED when its group is absent.
  // issues port
  readonly manifest?: CapabilityManifest;
  readonly credentialEnvKeys?: readonly string[];
  /** Fixed abstract→native link types (provider knowledge, not policy); see {@link buildIssuesPort}. */
  readonly linkMap?: LinkMap;
  createTransport?(env: Env): IssuesTransport;
  createIntrospector?(env: Env): Introspector;
  // scm port
  readonly scmManifest?: ScmManifest;
  /** Env keys for the scm transport (Azure adds AZURE_DEVOPS_REPO over the issues keys). */
  readonly scmCredentialEnvKeys?: readonly string[];
  createScmTransport?(env: Env): ScmTransport;
  // ci port
  readonly ciManifest?: CiManifest;
  readonly ciStatusMaps?: CiStatusMaps;
  readonly ciCredentialEnvKeys?: readonly string[];
  createCiTransport?(env: Env): CiTransport;
  // notify port
  readonly notifyManifest?: NotifyManifest;
  readonly notifyCredentialEnvKeys?: readonly string[];
  createNotifyTransport?(env: Env): NotifyTransport;
  // provider-native escape hatch (decision #18): raw authenticated REST, last resort, non-portable
  readonly nativeHttp?: NativeHttp;
}

const DESCRIPTORS: Record<string, ProviderDescriptor> = {
  [AZURE_DEVOPS_PROVIDER]: {
    id: AZURE_DEVOPS_PROVIDER,
    manifest: azureDevOpsManifest,
    credentialEnvKeys: ['AZURE_DEVOPS_ORG', 'AZURE_DEVOPS_PROJECT', 'AZURE_DEVOPS_TOKEN'],
    linkMap: exampleAzureDevOpsLinkMap,
    createTransport(env) {
      return createAzureDevOpsTransport({
        organization: env.AZURE_DEVOPS_ORG ?? '',
        project: env.AZURE_DEVOPS_PROJECT ?? '',
        token: env.AZURE_DEVOPS_TOKEN ?? '',
      });
    },
    createIntrospector(env) {
      return createAzureDevOpsIntrospector({
        organization: env.AZURE_DEVOPS_ORG ?? '',
        project: env.AZURE_DEVOPS_PROJECT ?? '',
        token: env.AZURE_DEVOPS_TOKEN ?? '',
      });
    },
    scmManifest: azureDevOpsScmManifest,
    scmCredentialEnvKeys: [
      'AZURE_DEVOPS_ORG',
      'AZURE_DEVOPS_PROJECT',
      'AZURE_DEVOPS_REPO',
      'AZURE_DEVOPS_TOKEN',
    ],
    createScmTransport(env) {
      return createAzureDevOpsScmTransport({
        organization: env.AZURE_DEVOPS_ORG ?? '',
        project: env.AZURE_DEVOPS_PROJECT ?? '',
        repository: env.AZURE_DEVOPS_REPO ?? '',
        token: env.AZURE_DEVOPS_TOKEN ?? '',
      });
    },
    ciManifest: azureDevOpsCiManifest,
    ciStatusMaps: azureDevOpsCiStatusMaps,
    ciCredentialEnvKeys: ['AZURE_DEVOPS_ORG', 'AZURE_DEVOPS_PROJECT', 'AZURE_DEVOPS_TOKEN'],
    createCiTransport(env) {
      return createAzureDevOpsCiTransport({
        organization: env.AZURE_DEVOPS_ORG ?? '',
        project: env.AZURE_DEVOPS_PROJECT ?? '',
        token: env.AZURE_DEVOPS_TOKEN ?? '',
      });
    },
    nativeHttp: {
      baseUrl: (env) => `https://dev.azure.com/${env.AZURE_DEVOPS_ORG ?? ''}`,
      authHeader: (env) => azureBasicAuth(env.AZURE_DEVOPS_TOKEN ?? ''),
    },
  },
  [GITHUB_PROVIDER]: {
    id: GITHUB_PROVIDER,
    manifest: githubManifest,
    credentialEnvKeys: ['GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_TOKEN'],
    linkMap: exampleGithubLinkMap,
    createTransport(env) {
      return createGithubTransport({
        owner: env.GITHUB_OWNER ?? '',
        repo: env.GITHUB_REPO ?? '',
        token: env.GITHUB_TOKEN ?? '',
      });
    },
    createIntrospector(env) {
      return createGithubIntrospector({
        owner: env.GITHUB_OWNER ?? '',
        repo: env.GITHUB_REPO ?? '',
        token: env.GITHUB_TOKEN ?? '',
      });
    },
    scmManifest: githubScmManifest,
    scmCredentialEnvKeys: ['GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_TOKEN'],
    createScmTransport(env) {
      return createGithubScmTransport({
        owner: env.GITHUB_OWNER ?? '',
        repo: env.GITHUB_REPO ?? '',
        token: env.GITHUB_TOKEN ?? '',
      });
    },
    ciManifest: githubCiManifest,
    ciStatusMaps: githubCiStatusMaps,
    ciCredentialEnvKeys: ['GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_TOKEN'],
    createCiTransport(env) {
      return createGithubCiTransport({
        owner: env.GITHUB_OWNER ?? '',
        repo: env.GITHUB_REPO ?? '',
        token: env.GITHUB_TOKEN ?? '',
      });
    },
    nativeHttp: {
      baseUrl: () => 'https://api.github.com',
      authHeader: (env) => `Bearer ${env.GITHUB_TOKEN ?? ''}`,
    },
  },
  [SLACK_PROVIDER]: {
    id: SLACK_PROVIDER,
    // Slack is notify-only: no issues/scm/ci groups.
    notifyManifest: slackNotifyManifest,
    notifyCredentialEnvKeys: ['SLACK_BOT_TOKEN', 'SLACK_CHANNEL'],
    createNotifyTransport(env) {
      return createSlackNotifyTransport({
        token: env.SLACK_BOT_TOKEN ?? '',
        ...(env.SLACK_CHANNEL !== undefined ? { defaultChannel: env.SLACK_CHANNEL } : {}),
      });
    },
    nativeHttp: {
      baseUrl: () => 'https://slack.com/api',
      authHeader: (env) => `Bearer ${env.SLACK_BOT_TOKEN ?? ''}`,
    },
  },
};

export const KNOWN_PROVIDERS = Object.keys(DESCRIPTORS);

export function getProviderDescriptor(id: string): ProviderDescriptor {
  const descriptor = DESCRIPTORS[id];
  if (descriptor === undefined) {
    throw new BaronError(
      `Unknown provider '${id}'. Known providers: ${KNOWN_PROVIDERS.join(', ')}.`,
      'UNKNOWN_PROVIDER',
    );
  }
  return descriptor;
}

/**
 * Build a live {@link IssuesPort} from a resolved policy config plus environment credentials: looks
 * up the provider, creates its live transport, and wraps it in the shared {@link BaseIssuesAdapter}
 * (which carries all role/native translation — invariant #4). This is the one call the MCP server
 * needs to turn a `policy.json` into a working issues port.
 */
export function buildIssuesPort(
  config: IssuesProviderConfig,
  env: Env,
  logger?: Logger,
): IssuesPort {
  const descriptor = getProviderDescriptor(config.provider);
  if (descriptor.manifest === undefined || descriptor.createTransport === undefined) {
    throw new BaronError(
      `Provider '${config.provider}' has no issues adapter.`,
      'ISSUES_UNSUPPORTED',
    );
  }
  // The link map is fixed provider knowledge (not in policy.json), so inject the descriptor's
  // unless the caller already supplied one.
  const resolved: IssuesProviderConfig = {
    ...config,
    linkMap: config.linkMap ?? descriptor.linkMap ?? {},
  };
  return new BaseIssuesAdapter(
    descriptor.manifest,
    resolved,
    descriptor.createTransport(env),
    logger,
  );
}

/**
 * Build a live {@link ScmPort} for a provider from environment credentials. The scm port has no
 * role/type map to resolve from policy, so it binds directly from the provider id + env + an
 * optional gap policy.
 */
export function buildScmPort(
  provider: string,
  env: Env,
  gapPolicy?: GapPolicy,
  logger?: Logger,
): ScmPort {
  const descriptor = getProviderDescriptor(provider);
  if (descriptor.scmManifest === undefined || descriptor.createScmTransport === undefined) {
    throw new BaronError(`Provider '${provider}' has no scm adapter.`, 'SCM_UNSUPPORTED');
  }
  return new BaseScmAdapter(
    descriptor.scmManifest,
    descriptor.createScmTransport(env),
    gapPolicy,
    logger,
  );
}

/**
 * Build a live {@link CiPort} for a provider from environment credentials. Like scm, the ci port has
 * no user-configured map to resolve from policy (CI statuses are vendor-fixed and normalized by the
 * adapter), so it binds from the provider id + env + an optional gap policy.
 */
export function buildCiPort(
  provider: string,
  env: Env,
  gapPolicy?: GapPolicy,
  logger?: Logger,
): CiPort {
  const descriptor = getProviderDescriptor(provider);
  if (
    descriptor.ciManifest === undefined ||
    descriptor.ciStatusMaps === undefined ||
    descriptor.createCiTransport === undefined
  ) {
    throw new BaronError(`Provider '${provider}' has no ci adapter.`, 'CI_UNSUPPORTED');
  }
  return new BaseCiAdapter(
    descriptor.ciManifest,
    descriptor.ciStatusMaps,
    descriptor.createCiTransport(env),
    gapPolicy,
    logger,
  );
}

/**
 * Build a live {@link NotifyPort} for a provider from environment credentials. Like scm/ci, notify
 * has no user-configured map in policy, so it binds from the provider id + env + an optional gap policy.
 */
export function buildNotifyPort(
  provider: string,
  env: Env,
  gapPolicy?: GapPolicy,
  logger?: Logger,
): NotifyPort {
  const descriptor = getProviderDescriptor(provider);
  if (descriptor.notifyManifest === undefined || descriptor.createNotifyTransport === undefined) {
    throw new BaronError(`Provider '${provider}' has no notify adapter.`, 'NOTIFY_UNSUPPORTED');
  }
  return new BaseNotifyAdapter(
    descriptor.notifyManifest,
    descriptor.createNotifyTransport(env),
    gapPolicy,
    logger,
  );
}

/**
 * Execute a provider-native escape-hatch request (decision #18). Looks up the provider's raw-HTTP
 * descriptor and runs the request with its base URL + auth; throws NATIVE_UNSUPPORTED if the provider
 * exposes no escape hatch. This is the last-resort, non-portable path — callers (e.g. the MCP server)
 * should restrict it to providers the active policy actually binds.
 */
export function executeNativeRequest(
  provider: string,
  env: Env,
  request: NativeRequest,
): Promise<NativeResponse> {
  const descriptor = getProviderDescriptor(provider);
  if (descriptor.nativeHttp === undefined) {
    throw new BaronError(
      `Provider '${provider}' has no native escape hatch.`,
      'NATIVE_UNSUPPORTED',
    );
  }
  return runNativeRequest(descriptor.nativeHttp, env, request);
}

export interface BoundPorts {
  issues?: IssuesPort;
  scm?: ScmPort;
  ci?: CiPort;
  notify?: NotifyPort;
}

/**
 * Build every port a parsed policy binds (issues and/or scm), from environment credentials. Shared
 * by the MCP server and the CLI's `run` so both turn a `policy.json` into live ports identically;
 * neither port is built unless `providers` binds it.
 */
export function buildPorts(policy: BaronPolicyFile, env: Env, logger?: Logger): BoundPorts {
  const ports: BoundPorts = {};
  if (policy.providers.issues !== undefined) {
    ports.issues = buildIssuesPort(resolveIssuesConfig(policy), env, logger);
  }
  const scmProvider = policy.providers.scm;
  if (scmProvider !== undefined) {
    const gapPolicy = parseGapPolicy(policy.gapPolicy?.[scmProvider] ?? {});
    ports.scm = buildScmPort(scmProvider, env, gapPolicy, logger);
  }
  const ciProvider = policy.providers.ci;
  if (ciProvider !== undefined) {
    const gapPolicy = parseGapPolicy(policy.gapPolicy?.[ciProvider] ?? {});
    ports.ci = buildCiPort(ciProvider, env, gapPolicy, logger);
  }
  const notifyProvider = policy.providers.notify;
  if (notifyProvider !== undefined) {
    const gapPolicy = parseGapPolicy(policy.gapPolicy?.[notifyProvider] ?? {});
    ports.notify = buildNotifyPort(notifyProvider, env, gapPolicy, logger);
  }
  return ports;
}
