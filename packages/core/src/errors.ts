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
    /**
     * The scope the lookup was made in, on a provider whose states are scoped (a Linear team owns
     * its own workflow states). Named in the message because "in_review is unmapped" and "in_review
     * is unmapped *for this team*" send you to different places in the policy.
     */
    readonly scope?: string,
  ) {
    super(
      scope === undefined
        ? `Role '${role}' has no native mapping for provider '${provider}'. Run \`baron init\` to ` +
            `(re)build the role map, or add it to policy.roleMap.${provider}.states.`
        : `Role '${role}' has no native mapping for provider '${provider}' in scope '${scope}'. ` +
            'Run `baron init` to (re)build the role map, or add it to ' +
            `policy.roleMap.${provider}.scopes.${scope}.`,
      'ROLE_MAPPING',
    );
  }
}

/**
 * An item lives in a scope the role map says nothing about — a Linear team added after `baron init`
 * ran, most likely.
 *
 * Deliberately an error rather than a fall back to the unscoped `states`. On a scoped provider the
 * default map belongs to no team, so falling back would send another team's state id to the
 * provider: a write that fails somewhere far from its cause, or worse, one that succeeds against
 * the wrong thing. A gap that is neither errored nor logged is a bug (ARCHITECTURE invariant 5).
 */
export class RoleScopeUnknownError extends BaronError {
  constructor(
    readonly scope: string,
    readonly provider: string,
    readonly known: readonly string[],
  ) {
    super(
      `Scope '${scope}' is not in the role map for provider '${provider}' (it knows: ` +
        `${known.length > 0 ? known.join(', ') : 'none'}). Run \`baron init\` to pick up new ` +
        `scopes, or add policy.roleMap.${provider}.scopes.${scope}.`,
      'ROLE_SCOPE_UNKNOWN',
    );
  }
}

/**
 * The provider will not move this item to that target from where it currently is.
 *
 * Not a capability gap and deliberately not negotiable by policy: the mapping is right, the write is
 * simply not permitted from this state. Emulating or degrading it would mean either moving the item
 * somewhere it was not asked to go, or reporting success for a move that did not happen. The
 * permitted set is named because "refused" without it leaves the caller guessing what to ask for.
 */
export class TransitionNotPermittedError extends BaronError {
  constructor(
    readonly role: string,
    readonly provider: string,
    readonly permitted: readonly string[],
  ) {
    super(
      `Provider '${provider}' will not move this item to role '${role}' from its current state. ` +
        `It permits: ${permitted.length > 0 ? permitted.join(', ') : '(nothing from here)'}.`,
      'TRANSITION_NOT_PERMITTED',
    );
  }
}
