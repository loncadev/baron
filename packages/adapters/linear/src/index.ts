import {
  BaseIssuesAdapter,
  type CapabilityManifest,
  type IssuesProviderConfig,
  type IssuesTransport,
  type Logger,
  type ProviderRoleMap,
  type TypeMap,
} from '@lonca/baron-core';
import { LINEAR_PROVIDER, LINEAR_STATE_KEY } from './provider.js';

/**
 * What Linear can actually do, read off its GraphQL schema rather than its marketing.
 *
 * The interesting entries are the two that differ from every provider shipped before it. Hierarchy
 * is NATIVE — `Issue.parent` and `Issue.children` exist — so nothing here emulates it with labels
 * the way GitHub must. And work-item types do not exist at all: an issue is an issue, so the
 * abstract type role rides a label exactly as it does on GitHub.
 */
export const linearManifest: CapabilityManifest = {
  provider: LINEAR_PROVIDER,
  issues: {
    hierarchy: true,
    subIssues: true,
    separateBoardColumn: false,
    // Cycles are Linear's sprints, and `Issue.cycle` is a first-class field.
    sprints: true,
    // Teams define their own workflow states, so far beyond open/closed.
    arbitraryStates: true,
    nativeLabels: true,
    // `IssueCreateInput` has no type field: Linear models one kind of issue.
    nativeTypes: false,
    // `IssueFilter` cannot filter by a work-item type Linear does not have. Declaring this false is
    // what makes the core post-filter instead of handing back an unfiltered list as if it were one.
    typeFiltering: false,
    comments: true,
    issueLinks: true,
    assignment: true,
  },
};

/**
 * Linear's native relation types, for `issue.link`.
 *
 * `duplicate` and `related` are the two the API models; a parent/child link is not a relation here
 * but the `parent` field, which hierarchy already covers.
 */
export const exampleLinearLinkMap = { relates: 'related', duplicates: 'duplicate' } as const;

/**
 * A worked example of a SCOPED role map — the thing Linear forces and no other shipped provider
 * needs. Every id below is a `WorkflowState.id`, and the same role is a different id per team,
 * because `WorkflowState.team` is non-null. Names are unusable as keys: two teams both have an
 * "In Progress" and they are different rows.
 *
 * Illustrative only. Real ids come from `baron init` introspecting the workspace.
 */
export const exampleLinearRoleMap: ProviderRoleMap = {
  stateKey: LINEAR_STATE_KEY,
  // Empty on purpose: on a scoped provider the unscoped map belongs to no team, so there is nothing
  // correct to put here — anything resolved through it would be some other team's state.
  states: {},
  scopes: {
    ENG: {
      backlog: { [LINEAR_STATE_KEY]: 'eng-backlog' },
      in_progress: { [LINEAR_STATE_KEY]: 'eng-in-progress' },
      in_review: { [LINEAR_STATE_KEY]: 'eng-code-review' },
      done: { [LINEAR_STATE_KEY]: 'eng-done' },
    },
  },
};

/** Linear has no work-item types, so every role maps to the one kind of thing it has. */
export const exampleLinearTypeMap: TypeMap = {
  epic: 'Issue',
  story: 'Issue',
  task: 'Issue',
  bug: 'Issue',
};

export type LinearIssuesConfig = Omit<IssuesProviderConfig, 'provider'>;

export function defineLinearIssuesAdapter(
  config: LinearIssuesConfig,
  transport: IssuesTransport,
  logger?: Logger,
): BaseIssuesAdapter {
  return new BaseIssuesAdapter(
    linearManifest,
    { linkMap: exampleLinearLinkMap, ...config, provider: LINEAR_PROVIDER },
    transport,
    logger,
  );
}

export { LINEAR_PROVIDER, LINEAR_STATE_KEY } from './provider.js';
export {
  BARON_LINEAR_CLIENT_ID,
  LINEAR_CALLBACK_PORT,
  LINEAR_CALLBACK_PORT_ENV,
  createLinearPkceAuth,
  type LinearPkceAuthOptions,
  linearCallbackUri,
} from './pkce-auth.js';
export {
  LINEAR_OAUTH_CLIENT_ID_KEY,
  LINEAR_REFRESH_TOKEN_KEY,
  LINEAR_TOKEN_EXPIRES_AT_KEY,
  type LinearOAuthSession,
} from './oauth.js';
export { createLinearTransport, type LinearTransportOptions } from './transport.js';
export { createLinearIntrospector, type LinearIntrospectorOptions } from './introspector.js';
export {
  createLinearCredentialProbe,
  type LinearCredentialProbeOptions,
} from './credential.js';
