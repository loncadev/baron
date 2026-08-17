import type { IssueLinkType } from './links.js';
import type { GapPolicy } from './policy.js';
import { BLOCKED_LABEL, type WorkItemTypeRole, type WorkflowRole } from './roles.js';

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
  /**
   * Per-scope maps, for a provider whose states do not belong to the workspace but to something
   * inside it. Linear is the case that forces this: `WorkflowState.team` is non-null, so two teams
   * legitimately hold different states for the same role — `in_progress` is one id in one team and
   * a different id in another, even when both are named "In Progress".
   *
   * A scope's map REPLACES {@link states} for items in that scope; it does not merge over it. On a
   * provider where every role differs per scope, merging saves nothing and buys a silent failure: a
   * role omitted from a scope would resolve to some other scope's target and be rejected by the
   * provider far from the cause. Replacing turns the same mistake into a RoleMappingError that names
   * the role and the scope.
   *
   * Absent on Azure DevOps and GitHub, whose states belong to the whole project or repository.
   */
  readonly scopes?: Readonly<Record<string, Partial<Record<WorkflowRole, NativeTarget>>>>;
}

/** The NativeTarget key that carries a role's label (GitHub). Centralized so it isn't a raw literal. */
export const ROLE_LABEL_KEY = 'label';

/**
 * A label Baron provisions so a role's label exists deliberately — a named color and description —
 * instead of the grey, description-less label a provider auto-creates the first time it's applied.
 */
export interface LabelSpec {
  readonly name: string;
  /** 6-hex color, no leading '#', GitHub-style. */
  readonly color: string;
  readonly description: string;
}

/** Baron's presentation per workflow role, used when provisioning that role's label. */
const ROLE_LABEL_STYLE: Record<
  WorkflowRole,
  { readonly color: string; readonly description: string }
> = {
  backlog: { color: 'ededed', description: 'Baron: backlog' },
  ready: { color: 'c5def5', description: 'Baron: ready to start' },
  in_progress: { color: 'fbca04', description: 'Baron: in progress' },
  in_review: { color: '1d76db', description: 'Baron: in review' },
  done: { color: '0e8a16', description: 'Baron: done' },
};

/**
 * The labels to provision for a role map: one per role whose native target carries a label. Empty
 * for a provider whose roles ride native states (Azure), so provisioning is a no-op there — this is
 * what makes label provisioning portable rather than a GitHub special case.
 */
/**
 * The type-role labels to provision. Only meaningful on a provider whose native types are flat
 * (several roles share one native type) — there the role rides a `type:<role>` label, so provision
 * those deliberately instead of letting the provider auto-create them grey. Empty for a provider
 * with real work-item types (Azure), keeping this portable rather than a GitHub special case.
 */
export function typeRoleLabelSpecs(typeMap: TypeMap): LabelSpec[] {
  const counts = new Map<string, number>();
  for (const native of Object.values(typeMap)) {
    if (native !== undefined) counts.set(native, (counts.get(native) ?? 0) + 1);
  }
  const specs: LabelSpec[] = [];
  for (const [role, native] of Object.entries(typeMap)) {
    if (native === undefined || (counts.get(native) ?? 0) <= 1) continue;
    specs.push({
      name: `type:${role}`,
      color: 'd4c5f9',
      description: `Baron: work-item type '${role}'`,
    });
  }
  return specs;
}

/**
 * The orthogonal blocked flag's label, provisioned deliberately like every other Baron label so it
 * is not left grey and description-less the first time something is blocked.
 */
export const BLOCKED_LABEL_SPEC: LabelSpec = {
  name: BLOCKED_LABEL,
  color: 'd93f0b',
  description: 'Baron: blocked (orthogonal to the workflow role)',
};

export function roleLabelSpecs(roleMap: ProviderRoleMap): LabelSpec[] {
  const seen = new Set<string>();
  const specs: LabelSpec[] = [];
  for (const [role, target] of Object.entries(roleMap.states)) {
    const name = target?.[ROLE_LABEL_KEY];
    if (name === undefined || name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    const style = ROLE_LABEL_STYLE[role as WorkflowRole];
    specs.push({ name, color: style.color, description: style.description });
  }
  return specs;
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
