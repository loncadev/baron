import {
  BaronError,
  type CredentialFinding,
  type CredentialProbe,
  type Introspector,
  WORK_ITEM_TYPE_ROLES,
  parsePolicyJson,
  requiredCredentialCapabilities,
  resolveIssuesConfig,
} from '@lonca/baron-core';
import { type Env, getProviderDescriptor } from '@lonca/baron-providers';
import { policyPath } from './paths.js';
import type { FileSystem } from './ports.js';

export interface DoctorOptions {
  readonly root: string;
  readonly fs: FileSystem;
  /** Injected introspector (tests). When absent, built from the registry + env credentials. */
  readonly introspector?: Introspector;
  /** Injected probe lookup (tests). When absent, built from the registry + env credentials. */
  readonly probeFor?: (provider: string) => CredentialProbe | undefined;
  readonly env?: Env;
}

/** A capability finding with the provider whose credential it was asked about. */
export interface DoctorCredentialFinding extends CredentialFinding {
  readonly provider: string;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly policyPath: string;
  readonly provider: string;
  /** Human-readable drift findings; empty when the policy still matches the live provider. */
  readonly drift: readonly string[];
  /** How many references were checked (states, columns, types). */
  readonly checks: number;
  /**
   * What each bound provider's credential can actually do. A `denied` here fails the report: it is
   * the difference between a policy that matches the provider and an installation that works.
   */
  readonly credentials: readonly DoctorCredentialFinding[];
  /**
   * Abstract type roles the policy maps onto nothing. Not drift — the policy is internally valid —
   * but `issue.create` refuses each of them, so a silent omission here surfaces as a failed run
   * much later. Reported, never fatal: on some providers a role genuinely has no native equivalent.
   */
  readonly unmappedTypeRoles: readonly string[];
  /**
   * Native types no type role maps back FROM. Every item reporting one of these resolves to no type
   * role, and therefore to no canonical branch — the failure that made `task-start` refuse every
   * issue in this repository.
   */
  readonly unreachableNativeTypes: readonly string[];
  /**
   * What loading the policy had to change to make it valid under the current contract. The file on
   * disk is untouched until `baron init` rewrites it, so this is the only place a silent correction
   * becomes visible — and a loader that corrects without saying so is how drift becomes permanent.
   */
  readonly migrations: readonly string[];
}

/**
 * Ask each bound provider's credential what it can do. A provider with no probe yields explicit
 * `unknown` findings rather than none at all — "we did not check" has to reach the report, because
 * silently assuming a credential works is exactly the failure this check exists to prevent.
 */
async function checkCredentials(
  policy: ReturnType<typeof parsePolicyJson>,
  probeFor: (provider: string) => CredentialProbe | undefined,
): Promise<DoctorCredentialFinding[]> {
  const findings: DoctorCredentialFinding[] = [];
  for (const [provider, capabilities] of requiredCredentialCapabilities(policy.providers)) {
    const probe = probeFor(provider);
    if (probe === undefined) {
      for (const capability of capabilities) {
        findings.push({
          provider,
          capability,
          status: 'unknown',
          detail: `provider '${provider}' cannot report what a credential may do; not checked.`,
        });
      }
      continue;
    }
    try {
      for (const finding of await probe.probe(capabilities)) {
        findings.push({ provider, ...finding });
      }
    } catch (error) {
      for (const capability of capabilities) {
        findings.push({
          provider,
          capability,
          status: 'unknown',
          detail: `probe failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }
  return findings;
}

/**
 * `baron doctor`: load `.baron/policy.json`, introspect the live issues provider, and report any
 * drift — a mapped native state/type/column that no longer exists — then verify that each bound
 * provider's credential can actually perform what those ports imply. Returns a structured report
 * (the CLI shell turns a non-ok report into a non-zero exit) rather than printing directly, so the
 * check is testable. Label-discriminated providers skip native-state checks (labels are
 * Baron-managed, not introspected).
 *
 * Drift and credentials answer two different questions, and only checking the first is what made a
 * green doctor compatible with a `task-start` that fails on the very next command.
 */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const path = policyPath(options.root);
  const raw = options.fs.read(path);
  if (raw === undefined) {
    throw new BaronError(
      `No policy found at ${path}. Run \`baron init\` first.`,
      'POLICY_NOT_FOUND',
    );
  }

  const policy = parsePolicyJson(raw);
  const config = resolveIssuesConfig(policy);
  const descriptor = getProviderDescriptor(config.provider);
  if (options.introspector === undefined && descriptor.createIntrospector === undefined) {
    throw new BaronError(
      `Provider '${config.provider}' has no issues adapter to introspect.`,
      'ISSUES_UNSUPPORTED',
    );
  }
  const introspector = options.introspector ?? descriptor.createIntrospector!(options.env ?? {});
  const introspection = await introspector.introspect();

  const stateNames = new Set(introspection.states.map((s) => s.name));
  const typeNames = new Set(introspection.workItemTypes.map((t) => t.name));
  const columnNames = new Set(introspection.boardColumns ?? []);

  const drift: string[] = [];
  let checks = 0;

  for (const [typeRole, native] of Object.entries(config.typeMap)) {
    checks += 1;
    if (!typeNames.has(native)) {
      drift.push(
        `type role '${typeRole}' maps to native type '${native}', which no longer exists.`,
      );
    }
  }

  const stateKey = config.roleMap.stateKey;
  for (const [role, target] of Object.entries(config.roleMap.states)) {
    if (target === undefined) continue;

    // Only native-state discriminators can drift against introspection; emulated label states
    // are Baron-managed and have nothing to validate against.
    if (stateKey === 'state') {
      const stateValue = target.state;
      if (stateValue !== undefined) {
        checks += 1;
        if (!stateNames.has(stateValue)) {
          drift.push(
            `role '${role}' maps to native state '${stateValue}', which no longer exists.`,
          );
        }
      }
    }

    if (target.boardColumn !== undefined) {
      checks += 1;
      if (!columnNames.has(target.boardColumn)) {
        drift.push(
          `role '${role}' maps to board column '${target.boardColumn}', which no longer exists.`,
        );
      }
    }
  }

  // Coverage, both directions. Drift asks whether what IS mapped still exists; this asks whether
  // anything is missing from the map at all — the question that goes unasked until a run fails.
  const mappedRoles = new Set(Object.keys(config.typeMap));
  const unmappedTypeRoles = WORK_ITEM_TYPE_ROLES.filter((role) => !mappedRoles.has(role));
  const mappedNativeTypes = new Set(Object.values(config.typeMap));
  const unreachableNativeTypes = introspection.workItemTypes
    .map((t) => t.name)
    .filter((name) => !mappedNativeTypes.has(name));

  const env = options.env ?? {};
  const probeFor =
    options.probeFor ??
    ((provider: string) => getProviderDescriptor(provider).createCredentialProbe?.(env));
  const credentials = await checkCredentials(policy, probeFor);

  const ok = drift.length === 0 && !credentials.some((f) => f.status === 'denied');
  return {
    ok,
    policyPath: path,
    provider: config.provider,
    drift,
    checks,
    credentials,
    unmappedTypeRoles,
    unreachableNativeTypes,
    migrations: policy.migrations ?? [],
  };
}
