import {
  AZURE_DEVOPS_PROVIDER,
  azureDevOpsManifest,
  createAzureDevOpsIntrospector,
  createAzureDevOpsTransport,
  exampleAzureDevOpsLinkMap,
} from '@baron/adapter-azure-devops';
import {
  GITHUB_PROVIDER,
  createGithubIntrospector,
  createGithubTransport,
  exampleGithubLinkMap,
  githubManifest,
} from '@baron/adapter-github';
import {
  BaronError,
  BaseIssuesAdapter,
  type CapabilityManifest,
  type Introspector,
  type IssuesPort,
  type IssuesProviderConfig,
  type IssuesTransport,
  type LinkMap,
  type Logger,
} from '@baron/core';

export * from './paths.js';

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
  readonly manifest: CapabilityManifest;
  readonly credentialEnvKeys: readonly string[];
  /** Fixed abstract→native link types (provider knowledge, not policy); see {@link buildIssuesPort}. */
  readonly linkMap: LinkMap;
  createTransport(env: Env): IssuesTransport;
  createIntrospector(env: Env): Introspector;
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
  // The link map is fixed provider knowledge (not in policy.json), so inject the descriptor's
  // unless the caller already supplied one.
  const resolved: IssuesProviderConfig = {
    ...config,
    linkMap: config.linkMap ?? descriptor.linkMap,
  };
  return new BaseIssuesAdapter(
    descriptor.manifest,
    resolved,
    descriptor.createTransport(env),
    logger,
  );
}
