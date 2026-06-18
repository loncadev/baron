/** Base class for all Baron errors so callers can `instanceof BaronError`. */
export class BaronError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Thrown when an operation needs a capability the provider lacks and the configured gap policy
 * for that capability is `error` (strict). The message names the capability and provider so it
 * is actionable, never a silent no-op.
 */
export class CapabilityGapError extends BaronError {
  constructor(
    readonly capability: string,
    readonly provider: string,
  ) {
    super(
      `Provider '${provider}' does not support capability '${capability}', and the gap policy ` +
        `for '${capability}' is 'error'. Set gapPolicy.${capability} to 'emulate:<strategy>' or ` +
        `'degrade' to proceed.`,
      'CAPABILITY_GAP',
    );
  }
}

/** Thrown when a workflow role has no native mapping for the active provider. */
export class RoleMappingError extends BaronError {
  constructor(
    readonly role: string,
    readonly provider: string,
  ) {
    super(
      `Role '${role}' has no native mapping for provider '${provider}'. Run \`baron init\` to ` +
        `(re)build the role map, or add it to policy.roleMap.${provider}.states.`,
      'ROLE_MAPPING',
    );
  }
}
