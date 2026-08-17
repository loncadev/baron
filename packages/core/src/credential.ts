import type { PortName } from './policy-file.js';

/**
 * What a credential must be able to DO for the ports a policy binds. Deliberately coarse: this is
 * not a provider's permission vocabulary (GitHub's `contents=write`, Azure's `Code (Read & Write)`)
 * but the port-level need those vocabularies get checked against. The adapter owns the translation,
 * the same way it owns every other provider-native detail.
 */
export const CREDENTIAL_CAPABILITIES = [
  'issues:read',
  'issues:write',
  'scm:read',
  'scm:write',
] as const;

export type CredentialCapability = (typeof CREDENTIAL_CAPABILITIES)[number];

/**
 * `unknown` is a first-class outcome, not a failed attempt. A provider with no way to ask what a
 * credential may do has to say so, because the alternative — assuming yes — is what let `doctor`
 * report a sound installation right before the first write failed.
 */
/**
 * What a probe concluded about one capability.
 *
 * `unknown` and `error` are deliberately separate. `unknown` is a known limitation — this provider
 * cannot report what a credential may do — and must not turn a correctly configured install red.
 * `error` is the probe running and failing, which means something IS wrong; collapsing the two let
 * `baron doctor` lead with OK and exit 0 while it had in fact verified nothing.
 */
export const CREDENTIAL_STATUSES = ['granted', 'denied', 'unknown', 'error'] as const;

export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

export interface CredentialFinding {
  readonly capability: CredentialCapability;
  readonly status: CredentialStatus;
  /** The provider's own name for the permission ('Contents: Read and write') — what the user grants. */
  readonly nativePermission?: string;
  /** Why the probe concluded what it did; carried into the report so `unknown` is never mute. */
  readonly detail?: string;
}

/**
 * Provider I/O only (invariant #4): answers what a credential may do and decides nothing about it.
 * Which capabilities to ask for comes from the bound ports, and what a `denied` means for the exit
 * code is the caller's call.
 *
 * A probe MUST NOT mutate. Where a provider offers no read-only way to test a write, the honest
 * implementation is an authorization-only request the provider rejects on its merits (an invalid
 * body it validates *after* authorization) — or `unknown`.
 */
export interface CredentialProbe {
  probe(capabilities: readonly CredentialCapability[]): Promise<readonly CredentialFinding[]>;
}

/** Which capabilities a bound port implies. A port nobody binds imposes nothing. */
const PORT_CAPABILITIES: Partial<Record<PortName, readonly CredentialCapability[]>> = {
  issues: ['issues:read', 'issues:write'],
  scm: ['scm:read', 'scm:write'],
};

/**
 * Derive what each provider's credential has to be able to do, from the ports the policy actually
 * binds. Keyed by provider because a policy mixes them — a GitHub token bound only to `scm` is not
 * asked to prove it can write issues.
 */
export function requiredCredentialCapabilities(
  providers: Partial<Record<PortName, string>>,
): ReadonlyMap<string, readonly CredentialCapability[]> {
  const byProvider = new Map<string, CredentialCapability[]>();
  for (const [port, provider] of Object.entries(providers)) {
    if (provider === undefined) continue;
    const capabilities = PORT_CAPABILITIES[port as PortName];
    if (capabilities === undefined) continue;
    const existing = byProvider.get(provider) ?? [];
    for (const capability of capabilities) {
      if (!existing.includes(capability)) existing.push(capability);
    }
    byProvider.set(provider, existing);
  }
  return byProvider;
}
