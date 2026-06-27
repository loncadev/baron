import {
  BaseIssuesAdapter,
  type CapabilityManifest,
  type IssuesProviderConfig,
  type IssuesTransport,
  type LinkMap,
  type Logger,
  type ProviderRoleMap,
  type TypeMap,
} from '@baron/core';

export const AZURE_DEVOPS_PROVIDER = 'azure-devops';

/**
 * Azure Boards has rich, native modelling: parent/child hierarchy, a board column distinct from
 * the workflow state, sprints, and arbitrary process-template states.
 */
export const azureDevOpsManifest: CapabilityManifest = {
  provider: AZURE_DEVOPS_PROVIDER,
  issues: {
    hierarchy: true,
    subIssues: false,
    separateBoardColumn: true,
    sprints: true,
    arbitraryStates: true,
    nativeLabels: true,
    comments: true,
    issueLinks: true,
  },
};

/**
 * Example role map modelled on the Beetegre V2 Scrum process (states + board columns). Each
 * installation owns its own map; `baron init` introspects the real project and proposes one.
 */
export const exampleAzureDevOpsRoleMap: ProviderRoleMap = {
  stateKey: 'state',
  states: {
    backlog: { state: 'New' },
    in_progress: { state: 'Active', boardColumn: 'In Progress' },
    in_review: { state: 'Test', boardColumn: 'Test' },
    done: { state: 'Closed' },
  },
};

export const exampleAzureDevOpsTypeMap: TypeMap = {
  epic: 'Epic',
  story: 'Product Backlog Item',
  task: 'Task',
  subtask: 'Task',
};

/** Abstract link types onto Azure's fixed native link reference names. */
export const exampleAzureDevOpsLinkMap: LinkMap = {
  relates: 'System.LinkTypes.Related',
  blocks: 'System.LinkTypes.Dependency-Forward',
  blocked_by: 'System.LinkTypes.Dependency-Reverse',
  duplicates: 'System.LinkTypes.Duplicate-Forward',
};

export type AzureDevOpsIssuesConfig = Omit<IssuesProviderConfig, 'provider'>;

/**
 * Builds the Azure DevOps `issues` port. The adapter contributes only the manifest; all
 * role/native translation and gap negotiation come from the shared {@link BaseIssuesAdapter}.
 */
export function defineAzureDevOpsIssuesAdapter(
  config: AzureDevOpsIssuesConfig,
  transport: IssuesTransport,
  logger?: Logger,
): BaseIssuesAdapter {
  return new BaseIssuesAdapter(
    azureDevOpsManifest,
    { linkMap: exampleAzureDevOpsLinkMap, ...config, provider: AZURE_DEVOPS_PROVIDER },
    transport,
    logger,
  );
}

export { createAzureDevOpsTransport, type AzureDevOpsTransportOptions } from './transport.js';
export { createAzureDevOpsIntrospector } from './introspector.js';
export {
  createAzureDevOpsScmTransport,
  defineAzureDevOpsScmAdapter,
  azureDevOpsScmManifest,
  type AzureDevOpsScmTransportOptions,
} from './scm.js';
