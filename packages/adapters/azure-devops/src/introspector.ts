import { BaronError, type Introspector } from '@baron/core';
import type { AzureDevOpsTransportOptions } from './transport.js';

/**
 * Live introspection over the Azure DevOps REST API (work-item types, states, board columns,
 * iterations). Deferred alongside the live transport: `baron init`'s proposal logic is validated
 * with the in-memory introspector in the conformance suite. This factory keeps the surface stable.
 */
export function createAzureDevOpsIntrospector(_options: AzureDevOpsTransportOptions): Introspector {
  throw new BaronError(
    'Azure DevOps live introspection is not wired yet. The config engine validates its proposal ' +
      'logic via the in-memory introspector (conformance suite). Live REST wiring is the next step.',
    'NOT_IMPLEMENTED',
  );
}
