import {
  BaseIssuesAdapter,
  type CapabilityManifest,
  type GapPolicy,
  type IssuesProviderConfig,
  type IssuesTransport,
  type LinkMap,
  type Logger,
  type ProviderRoleMap,
  type TypeMap,
} from '@lonca/baron-core';
import { GITHUB_PROVIDER } from './provider.js';

export { GITHUB_PROVIDER } from './provider.js';

/**
 * GitHub Issues is deliberately flat: no native parent/child hierarchy (sub-issues exist but are
 * a separate primitive), and only binary open/closed states. Workflow states beyond that must be
 * emulated (Baron does this via labels). This is the divergent counterpart to Azure and the
 * reason the impedance layer earns its keep.
 */
export const githubManifest: CapabilityManifest = {
  provider: GITHUB_PROVIDER,
  issues: {
    hierarchy: false,
    subIssues: true,
    separateBoardColumn: false,
    sprints: false,
    arbitraryStates: false,
    nativeLabels: true,
    comments: true,
    issueLinks: false,
  },
};

/** Example role map: mid-workflow roles ride on labels, `done` closes the issue. */
export const exampleGithubRoleMap: ProviderRoleMap = {
  stateKey: 'label',
  states: {
    in_progress: { label: 'in-progress' },
    in_review: { label: 'in-review' },
    done: { state: 'closed', label: 'done' },
  },
};

/** GitHub has one issue type; every type role maps onto a plain issue. */
export const exampleGithubTypeMap: TypeMap = {
  epic: 'issue',
  story: 'issue',
  task: 'issue',
  subtask: 'issue',
};

/** GitHub has no native typed links; links are emulated/degraded per the gap policy, so this is empty. */
export const exampleGithubLinkMap: LinkMap = {};

/**
 * Recommended gap policy for GitHub: emulate hierarchy and arbitrary states via labels, and drop
 * sprints with a warning. Installations may override; the point is the choice is explicit, not a
 * silent default baked into the adapter.
 */
export const recommendedGithubGapPolicy: GapPolicy = {
  hierarchy: { kind: 'emulate', strategy: 'labels' },
  arbitraryStates: { kind: 'emulate', strategy: 'labels' },
  sprints: { kind: 'degrade' },
  issueLinks: { kind: 'emulate', strategy: 'labels' },
};

export type GithubIssuesConfig = Omit<IssuesProviderConfig, 'provider'>;

export function defineGithubIssuesAdapter(
  config: GithubIssuesConfig,
  transport: IssuesTransport,
  logger?: Logger,
): BaseIssuesAdapter {
  return new BaseIssuesAdapter(
    githubManifest,
    { linkMap: exampleGithubLinkMap, ...config, provider: GITHUB_PROVIDER },
    transport,
    logger,
  );
}

export { createGithubTransport, type GithubTransportOptions } from './transport.js';
export { createGithubIntrospector } from './introspector.js';
export {
  createGithubScmTransport,
  defineGithubScmAdapter,
  githubScmManifest,
} from './scm.js';
export {
  createGithubCiTransport,
  defineGithubCiAdapter,
  githubCiManifest,
  githubCiStatusMaps,
} from './ci.js';
export {
  createGithubDeployTransport,
  defineGithubDeployAdapter,
  githubDeployManifest,
  githubDeployStatusMaps,
} from './deploy.js';
