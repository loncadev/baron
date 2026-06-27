import type { IssueLinkType } from './links.js';
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

/**
 * Map of abstract link types onto provider-native link type names (Azure `System.LinkTypes.*`).
 * Unlike the role/type maps this is FIXED provider knowledge, not install-specific config, so the
 * adapter supplies it rather than `policy.json`.
 */
export type LinkMap = Partial<Record<IssueLinkType, string>>;

/** Everything an `issues` adapter needs that is policy (committed), not credentials. */
export interface IssuesProviderConfig {
  readonly provider: string;
  readonly roleMap: ProviderRoleMap;
  readonly typeMap: TypeMap;
  readonly gapPolicy: GapPolicy;
  /** Abstract→native link types. Adapter-supplied (fixed provider knowledge); defaults to empty. */
  readonly linkMap?: LinkMap;
}
