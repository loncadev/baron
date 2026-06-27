import { BaronError, type Introspector, parsePolicyJson, resolveIssuesConfig } from '@baron/core';
import { type Env, getProviderDescriptor } from '@baron/providers';
import { policyPath } from './paths.js';
import type { FileSystem } from './ports.js';

export interface DoctorOptions {
  readonly root: string;
  readonly fs: FileSystem;
  /** Injected introspector (tests). When absent, built from the registry + env credentials. */
  readonly introspector?: Introspector;
  readonly env?: Env;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly policyPath: string;
  readonly provider: string;
  /** Human-readable drift findings; empty when the policy still matches the live provider. */
  readonly drift: readonly string[];
  /** How many references were checked (states, columns, types). */
  readonly checks: number;
}

/**
 * `baron doctor`: load `.baron/policy.json`, introspect the live issues provider, and report any
 * drift — a mapped native state/type/column that no longer exists. Returns a structured report
 * (the CLI shell turns a non-ok report into a non-zero exit) rather than printing directly, so the
 * check is testable. Label-discriminated providers skip native-state checks (labels are
 * Baron-managed, not introspected).
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

  const introspector = options.introspector ?? descriptor.createIntrospector(options.env ?? {});
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

  return { ok: drift.length === 0, policyPath: path, provider: config.provider, drift, checks };
}
