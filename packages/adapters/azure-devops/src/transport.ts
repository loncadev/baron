import { BaronError, type IssuesTransport } from '@baron/core';

export interface AzureDevOpsTransportOptions {
  readonly organization: string;
  readonly project: string;
  /** Personal access token. Read from env / secret-manager by the caller; never committed. */
  readonly token: string;
}

/**
 * Live transport over the Azure DevOps REST API (`azure-devops-node-api`). Wiring this is a
 * deferred step: the first slice proves the translation/impedance layer with the in-memory
 * transport in the conformance suite. This factory exists so the package surface is stable.
 */
export function createAzureDevOpsTransport(_options: AzureDevOpsTransportOptions): IssuesTransport {
  throw new BaronError(
    'Azure DevOps live transport is not wired yet. The first slice validates the translation ' +
      'layer via the conformance suite (in-memory transport). Live REST wiring is the next step.',
    'NOT_IMPLEMENTED',
  );
}
