import type { NativeTarget, ProviderRoleMap } from './config.js';
import { RoleMappingError, RoleScopeUnknownError } from './errors.js';
import type { WorkflowRole } from './roles.js';

/** A role's native target in one scope. `scope` is absent on providers that do not scope states. */
export interface ScopedTarget {
  readonly scope?: string | undefined;
  readonly target: NativeTarget;
}

/**
 * Pure, network-free translation between abstract workflow roles and provider-native targets.
 * This is the heart of the impedance solution: recipes speak roles, the resolver turns them into
 * whatever the provider actually needs (Azure state+column, GitHub label, Linear state id).
 *
 * Every lookup takes an optional scope, because on some providers a state does not belong to the
 * workspace but to something inside it — a Linear workflow state belongs to a team, so the same
 * role is a different target depending on which team the item is in. Providers whose states are
 * project-wide pass no scope and behave exactly as before.
 */
export class RoleResolver {
  constructor(
    private readonly map: ProviderRoleMap,
    private readonly provider: string,
  ) {}

  /** Whether this provider's states are scoped at all. */
  get scoped(): boolean {
    return this.map.scopes !== undefined;
  }

  /**
   * The map that applies in `scope`.
   *
   * A scope REPLACES the default rather than merging over it — see {@link ProviderRoleMap.scopes}
   * for why. An item in a scope the map does not know is an error rather than a fall back to the
   * default, because on a scoped provider the default belongs to no scope in particular, so falling
   * back would hand the provider some other scope's target.
   */
  private statesFor(scope: string | undefined): Partial<Record<WorkflowRole, NativeTarget>> {
    const scopes = this.map.scopes;
    if (scopes === undefined || scope === undefined) return this.map.states;
    const scoped = scopes[scope];
    if (scoped === undefined) {
      throw new RoleScopeUnknownError(scope, this.provider, Object.keys(scopes));
    }
    return scoped;
  }

  /** role -> native target. Throws RoleMappingError if the role is unmapped in this scope. */
  toNative(role: WorkflowRole, scope?: string): NativeTarget {
    const target = this.statesFor(scope)[role];
    if (target === undefined) {
      throw new RoleMappingError(role, this.provider, scope);
    }
    return target;
  }

  /** Whether a role has a native mapping (without throwing). */
  has(role: WorkflowRole, scope?: string): boolean {
    try {
      return this.statesFor(scope)[role] !== undefined;
    } catch {
      // An unknown scope maps nothing; callers asking "can I?" want false, not a throw.
      return false;
    }
  }

  /**
   * Every scope in which `role` has a target, so a caller filtering by role can ask about all of
   * them at once. A scope that does not map the role contributes nothing — on a team with no
   * in-review state, no item can be in review, so its absence is the honest answer rather than an
   * error. The caller decides whether that silence is worth reporting.
   */
  targetsForRole(role: WorkflowRole): readonly ScopedTarget[] {
    const scopes = this.map.scopes;
    if (scopes === undefined) {
      const target = this.map.states[role];
      return target === undefined ? [] : [{ target }];
    }
    return Object.entries(scopes).flatMap(([scope, states]) => {
      const target = states[role];
      return target === undefined ? [] : [{ scope, target }];
    });
  }

  /** Scopes this map knows about; empty on an unscoped provider. */
  knownScopes(): readonly string[] {
    return Object.keys(this.map.scopes ?? {});
  }

  /**
   * Reverse lookup: a provider-native discriminator value (e.g. Azure 'Active', GitHub
   * 'in-review') -> the role it represents. Returns undefined when nothing matches.
   */
  toRole(discriminatorValue: string, scope?: string): WorkflowRole | undefined {
    for (const [role, target] of Object.entries(this.statesFor(scope))) {
      if (target?.[this.map.stateKey] === discriminatorValue) {
        return role as WorkflowRole;
      }
    }
    return undefined;
  }

  get discriminatorKey(): string {
    return this.map.stateKey;
  }
  /**
   * Every label this map uses to carry a role. Lets a caller clear the ones that no longer apply —
   * without it, labels accumulate (an item ends up tagged in-progress AND in-review).
   */
  roleLabels(scope?: string): string[] {
    if (this.map.stateKey !== 'label') return [];
    return Object.values(this.statesFor(scope))
      .map((target) => target?.label)
      .filter((label): label is string => label !== undefined && label.length > 0);
  }

  /**
   * The role carried by one of these labels. On a label-keyed provider a cold read can only report
   * open/closed, which matches no label — so resolving from the item's labels here (the resolver owns
   * the map; the transport must not) is what makes a plain `get` report the real role.
   */
  roleFromLabels(labels: readonly string[], scope?: string): WorkflowRole | undefined {
    if (this.map.stateKey !== 'label') return undefined;
    for (const [role, target] of Object.entries(this.statesFor(scope))) {
      const label = target?.label;
      if (label !== undefined && labels.includes(label)) return role as WorkflowRole;
    }
    return undefined;
  }

  /**
   * The role a provider's OWN state carries, regardless of which key this map is otherwise driven by.
   * A label-keyed map can still pin a native state (GitHub `done: { state: 'closed', label: 'done' }`),
   * and {@link toRole} would miss it because it only reads the map's `stateKey`. That blind spot let
   * an item the provider closed by itself — a PR merging with `Closes #N` — keep reporting the role
   * label nobody cleared.
   */
  roleFromNativeState(state: string, scope?: string): WorkflowRole | undefined {
    for (const [role, target] of Object.entries(this.statesFor(scope))) {
      if (target?.state === state) return role as WorkflowRole;
    }
    return undefined;
  }
}
