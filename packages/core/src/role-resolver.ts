import type { NativeTarget, ProviderRoleMap } from './config.js';
import { RoleMappingError } from './errors.js';
import type { WorkflowRole } from './roles.js';

/**
 * Pure, network-free translation between abstract workflow roles and provider-native targets.
 * This is the heart of the impedance solution: recipes speak roles, the resolver turns them into
 * whatever the provider actually needs (Azure state+column, GitHub label, etc.).
 */
export class RoleResolver {
  constructor(
    private readonly map: ProviderRoleMap,
    private readonly provider: string,
  ) {}

  /** role -> native target. Throws RoleMappingError if the role is unmapped for this provider. */
  toNative(role: WorkflowRole): NativeTarget {
    const target = this.map.states[role];
    if (target === undefined) {
      throw new RoleMappingError(role, this.provider);
    }
    return target;
  }

  /** Whether a role has a native mapping (without throwing). */
  has(role: WorkflowRole): boolean {
    return this.map.states[role] !== undefined;
  }

  /**
   * Reverse lookup: a provider-native discriminator value (e.g. Azure 'Active', GitHub
   * 'in-review') -> the role it represents. Returns undefined when nothing matches.
   */
  toRole(discriminatorValue: string): WorkflowRole | undefined {
    for (const [role, target] of Object.entries(this.map.states)) {
      if (target?.[this.map.stateKey] === discriminatorValue) {
        return role as WorkflowRole;
      }
    }
    return undefined;
  }

  get discriminatorKey(): string {
    return this.map.stateKey;
  }
}
