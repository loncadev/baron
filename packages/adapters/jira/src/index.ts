import {
  BaseIssuesAdapter,
  type CapabilityManifest,
  type IssuesProviderConfig,
  type IssuesTransport,
  type LinkMap,
  type Logger,
  type ProviderRoleMap,
  type TypeMap,
} from '@lonca/baron-core';
import { JIRA_PROVIDER, JIRA_STATE_KEY } from './provider.js';

/**
 * What Jira Cloud can actually do, read off its REST API rather than its marketing.
 *
 * The entry that defines this adapter is not in the manifest at all: Jira GATES transitions — a
 * status is reached only through a workflow transition the current status permits, and a transition
 * may carry a screen demanding fields. That is expressed through the transport's `availableTargets`
 * and `transitionFields`, which the core verifies against before every move.
 */
export const jiraManifest: CapabilityManifest = {
  provider: JIRA_PROVIDER,
  issues: {
    // One `parent` field covers sub-task -> story and story -> epic alike.
    hierarchy: true,
    subIssues: true,
    // Boards derive their columns from statuses; there is no second axis to set.
    separateBoardColumn: false,
    // Sprints exist, but on the Jira Software agile API, keyed by board rather than project. Left
    // out of this first cut and declared so, which makes the core degrade (or error) by policy
    // rather than pretend.
    sprints: false,
    arbitraryStates: true,
    nativeLabels: true,
    // Issue types are real and chosen at create time (Epic, Story, Task, Bug, Sub-task).
    nativeTypes: true,
    // JQL carries an `issuetype = …` clause, so the provider filters server-side.
    typeFiltering: true,
    comments: true,
    issueLinks: true,
    assignment: true,
  },
};

/**
 * Jira's default issue-link types, by the name the API takes.
 *
 * `blocked_by` is deliberately absent. Jira links are directional and named from the outward side
 * ("Blocks": outward blocks inward), and the transport always puts `from` on the outward side — so
 * "A is blocked by B" is written as `link(B, A, 'blocks')`. Mapping `blocked_by` to the same type
 * would silently link it backwards; leaving it unmapped makes the core refuse it with
 * LINK_MAPPING, which names the mistake.
 */
export const exampleJiraLinkMap: LinkMap = {
  relates: 'Relates',
  blocks: 'Blocks',
  duplicates: 'Duplicate',
};

/**
 * A worked example of a Jira role map for the default software workflow, keyed by status NAME.
 * Illustrative only: real names come from `baron init` introspecting the project, and a site with
 * a "Code Review" status would map `in_review` there.
 */
export const exampleJiraRoleMap: ProviderRoleMap = {
  stateKey: JIRA_STATE_KEY,
  states: {
    backlog: { [JIRA_STATE_KEY]: 'To Do' },
    in_progress: { [JIRA_STATE_KEY]: 'In Progress' },
    in_review: { [JIRA_STATE_KEY]: 'In Review' },
    done: { [JIRA_STATE_KEY]: 'Done' },
  },
};

/** The standard issue types of a Jira Software project. `initiative` needs Jira Premium's level. */
export const exampleJiraTypeMap: TypeMap = {
  epic: 'Epic',
  story: 'Story',
  task: 'Task',
  bug: 'Bug',
  subtask: 'Sub-task',
};

export type JiraIssuesConfig = Omit<IssuesProviderConfig, 'provider'>;

export function defineJiraIssuesAdapter(
  config: JiraIssuesConfig,
  transport: IssuesTransport,
  logger?: Logger,
): BaseIssuesAdapter {
  return new BaseIssuesAdapter(
    jiraManifest,
    { linkMap: exampleJiraLinkMap, ...config, provider: JIRA_PROVIDER },
    transport,
    logger,
  );
}

export { JIRA_PROVIDER, JIRA_STATE_KEY } from './provider.js';
export { createJiraTransport, type JiraTransportOptions } from './transport.js';
export { createJiraIntrospector, type JiraIntrospectorOptions } from './introspector.js';
export { createJiraCredentialProbe, type JiraCredentialProbeOptions } from './credential.js';
