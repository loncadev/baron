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

/**
 * Thrown when the provider refuses an operation because the credential lacks a permission — as
 * opposed to a capability the provider does not have at all ({@link CapabilityGapError}). Providers
 * word this badly: GitHub's "Resource not accessible by personal access token" names neither the
 * operation that failed nor the permission that would fix it. This names both.
 */
export class CredentialPermissionError extends BaronError {
  constructor(
    readonly provider: string,
    readonly port: string,
    readonly operation: string,
    readonly nativePermission: string | undefined,
    readonly providerMessage: string,
  ) {
    const required =
      nativePermission === undefined
        ? 'The provider did not say which permission is required.'
        : `It requires: ${nativePermission}.`;
    super(
      `Provider '${provider}' refused '${operation}' on the ${port} port: the credential is not ` +
        `permitted to do this. ${required} Grant it, then re-run \`baron doctor\` to confirm. ` +
        `(${provider} said: ${providerMessage})`,
      'CREDENTIAL_PERMISSION',
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
