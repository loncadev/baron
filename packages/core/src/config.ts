import type { GapPolicy } from './policy.js';
import type { WorkItemTypeRole, WorkflowRole } from './roles.js';

/**
 * A provider-native target a role maps onto. Intentionally an open record because the shape is
 * provider-specific: Azure uses `{ state, boardColumn }`, GitHub uses `{ label }` or
 * `{ state: 'closed' }`. The owning adapter's transport interprets these keys.
 */
export type NativeTarget = Record<string, string>;

export interface ProviderRoleMap {
  /**
   * Which key in a NativeTarget is the canonical discriminator for reverse lookup
   * (native state -> role). Azure: 'state'; GitHub: 'label'.
   */
  readonly stateKey: string;
  /** Forward map: workflow role -> provider-native target. */
  readonly states: Partial<Record<WorkflowRole, NativeTarget>>;
}

/** Map of abstract type roles onto provider-native work-item type names. */
export type TypeMap = Partial<Record<WorkItemTypeRole, string>>;

/** Everything an `issues` adapter needs that is policy (committed), not credentials. */
export interface IssuesProviderConfig {
  readonly provider: string;
  readonly roleMap: ProviderRoleMap;
  readonly typeMap: TypeMap;
  readonly gapPolicy: GapPolicy;
}
