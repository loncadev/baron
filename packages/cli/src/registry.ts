import {
  AZURE_DEVOPS_PROVIDER,
  azureDevOpsManifest,
  createAzureDevOpsIntrospector,
} from '@baron/adapter-azure-devops';
import { GITHUB_PROVIDER, createGithubIntrospector, githubManifest } from '@baron/adapter-github';
import { BaronError, type CapabilityManifest, type Introspector } from '@baron/core';

export type Env = Record<string, string | undefined>;

/**
 * What the CLI needs to know about a provider to drive `baron init` / `baron doctor`: its manifest
 * (for the gap-aware proposal), the env keys that carry its credentials (scaffolded into
 * `.baron/credentials.example`, never committed), and how to build a live introspector from them.
 */
export interface ProviderDescriptor {
  readonly id: string;
  readonly manifest: CapabilityManifest;
  readonly credentialEnvKeys: readonly string[];
  createIntrospector(env: Env): Introspector;
}

const DESCRIPTORS: Record<string, ProviderDescriptor> = {
  [AZURE_DEVOPS_PROVIDER]: {
    id: AZURE_DEVOPS_PROVIDER,
    manifest: azureDevOpsManifest,
    credentialEnvKeys: ['AZURE_DEVOPS_ORG', 'AZURE_DEVOPS_PROJECT', 'AZURE_DEVOPS_TOKEN'],
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
