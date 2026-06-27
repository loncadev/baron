import type { IssuesProviderConfig, NativeTarget, ProviderRoleMap, TypeMap } from './config.js';
import { BaronError } from './errors.js';
import { parseGapPolicy } from './policy.js';
import { isWorkItemTypeRole, isWorkflowRole } from './roles.js';

/**
 * Capability ports a policy can bind to a provider. Each binds independently — a real install
 * mixes providers (Linear issues + GitHub scm + Slack notify), so this is a map, not one provider.
 */
export const PORT_NAMES = ['issues', 'scm', 'notify', 'docs'] as const;
export type PortName = (typeof PORT_NAMES)[number];

/** Per-provider role map as it appears on disk (the in-code {@link ProviderRoleMap} verbatim). */
export interface PolicyRoleMapEntry {
  readonly stateKey: string;
  readonly states: Partial<Record<string, NativeTarget>>;
}

/**
 * The committed `.baron/policy.json`, parsed and validated. This is policy only — credentials live
 * outside the repo and are never represented here. `roleMap`, `typeMap`, and `gapPolicy` are all
 * keyed by provider id (not port) so one file can describe every provider the install mixes;
 * `providers` is what binds each port to one of them.
 */
export interface BaronPolicyFile {
  readonly version: 1;
  readonly providers: Partial<Record<PortName, string>>;
  readonly roleMap: Record<string, PolicyRoleMapEntry>;
  readonly typeMap: Record<string, TypeMap>;
  /** provider id -> capability name -> on-disk gap behavior string ('error' | 'degrade' | 'emulate:<s>'). */
  readonly gapPolicy?: Record<string, Record<string, string>>;
  readonly language?: { readonly interaction?: string; readonly artifacts?: string };
}

const PARSE_CODE = 'POLICY_PARSE';

function fail(message: string): never {
  throw new BaronError(message, PARSE_CODE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    fail(`policy.${path} must be an object.`);
  }
  return value;
}

/** Validate a NativeTarget: a flat record of string -> string. */
function parseNativeTarget(value: unknown, path: string): NativeTarget {
  const record = requireRecord(value, path);
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw !== 'string') {
      fail(`policy.${path}.${key} must be a string (native targets are flat string maps).`);
    }
    out[key] = raw;
  }
  return out;
}

function parseRoleMapEntry(value: unknown, provider: string): PolicyRoleMapEntry {
  const record = requireRecord(value, `roleMap.${provider}`);
  const { stateKey, states } = record;
  if (typeof stateKey !== 'string' || stateKey.length === 0) {
    fail(`policy.roleMap.${provider}.stateKey must be a non-empty string.`);
  }
  const statesRecord = requireRecord(states, `roleMap.${provider}.states`);
  const out: Record<string, NativeTarget> = {};
  for (const [role, target] of Object.entries(statesRecord)) {
    if (!isWorkflowRole(role)) {
      fail(
        `policy.roleMap.${provider}.states has unknown workflow role '${role}'. ` +
          'Roles are: backlog, ready, in_progress, in_review, blocked, done.',
      );
    }
    out[role] = parseNativeTarget(target, `roleMap.${provider}.states.${role}`);
  }
  return { stateKey, states: out };
}

function parseTypeMapEntry(value: unknown, provider: string): TypeMap {
  const record = requireRecord(value, `typeMap.${provider}`);
  const out: Record<string, string> = {};
  for (const [typeRole, native] of Object.entries(record)) {
    if (!isWorkItemTypeRole(typeRole)) {
      fail(
        `policy.typeMap.${provider} has unknown type role '${typeRole}'. ` +
          'Type roles are: initiative, epic, story, task, subtask.',
      );
    }
    if (typeof native !== 'string' || native.length === 0) {
      fail(`policy.typeMap.${provider}.${typeRole} must be a non-empty native type name.`);
    }
    out[typeRole] = native;
  }
  return out as TypeMap;
}

/**
 * Parse and validate an untrusted object (typically `JSON.parse` of `.baron/policy.json`) into a
 * {@link BaronPolicyFile}. Throws {@link BaronError} (`POLICY_PARSE`) with an actionable, pathed
 * message on any structural or domain-vocabulary violation, so a hand-edited policy fails loudly.
 */
export function parsePolicy(raw: unknown): BaronPolicyFile {
  const root = requireRecord(raw, '');

  if (root.version !== 1) {
    fail(`policy.version must be 1 (got ${JSON.stringify(root.version)}).`);
  }

  const providersRecord = requireRecord(root.providers, 'providers');
  const providers: Partial<Record<PortName, string>> = {};
  for (const [port, provider] of Object.entries(providersRecord)) {
    if (!(PORT_NAMES as readonly string[]).includes(port)) {
      fail(`policy.providers has unknown port '${port}'. Ports are: ${PORT_NAMES.join(', ')}.`);
    }
    if (typeof provider !== 'string' || provider.length === 0) {
      fail(`policy.providers.${port} must be a non-empty provider id.`);
    }
    providers[port as PortName] = provider;
  }

  const roleMapRecord = requireRecord(root.roleMap, 'roleMap');
  const roleMap: Record<string, PolicyRoleMapEntry> = {};
  for (const [provider, entry] of Object.entries(roleMapRecord)) {
    roleMap[provider] = parseRoleMapEntry(entry, provider);
  }

  const typeMapRecord = requireRecord(root.typeMap, 'typeMap');
  const typeMap: Record<string, TypeMap> = {};
  for (const [provider, entry] of Object.entries(typeMapRecord)) {
    typeMap[provider] = parseTypeMapEntry(entry, provider);
  }

  let gapPolicy: Record<string, Record<string, string>> | undefined;
  if (root.gapPolicy !== undefined) {
    const gapRecord = requireRecord(root.gapPolicy, 'gapPolicy');
    gapPolicy = {};
    for (const [provider, entry] of Object.entries(gapRecord)) {
      const perProvider = requireRecord(entry, `gapPolicy.${provider}`);
      const behaviors: Record<string, string> = {};
      for (const [capability, behavior] of Object.entries(perProvider)) {
        if (typeof behavior !== 'string') {
          fail(`policy.gapPolicy.${provider}.${capability} must be a string.`);
        }
        behaviors[capability] = behavior;
      }
      gapPolicy[provider] = behaviors;
    }
  }

  let language: BaronPolicyFile['language'];
  if (root.language !== undefined) {
    const langRecord = requireRecord(root.language, 'language');
    const { interaction, artifacts } = langRecord;
    if (interaction !== undefined && typeof interaction !== 'string') {
      fail('policy.language.interaction must be a string.');
    }
    if (artifacts !== undefined && typeof artifacts !== 'string') {
      fail('policy.language.artifacts must be a string.');
    }
    language = {
      ...(interaction !== undefined ? { interaction: interaction as string } : {}),
      ...(artifacts !== undefined ? { artifacts: artifacts as string } : {}),
    };
  }

  return {
    version: 1,
    providers,
    roleMap,
    typeMap,
    ...(gapPolicy !== undefined ? { gapPolicy } : {}),
    ...(language !== undefined ? { language } : {}),
  };
}

/** Serialize a policy to the canonical on-disk form (2-space indent, trailing newline). */
export function serializePolicy(policy: BaronPolicyFile): string {
  return `${JSON.stringify(policy, null, 2)}\n`;
}

/**
 * Project a parsed policy down to the {@link IssuesProviderConfig} the issues adapter consumes.
 * Resolves the issues-bound provider and assembles its role map, type map, and (parsed) gap policy.
 * Throws {@link BaronError} when the issues port is unbound or its provider lacks a role/type map.
 */
export function resolveIssuesConfig(policy: BaronPolicyFile): IssuesProviderConfig {
  const provider = policy.providers.issues;
  if (provider === undefined) {
    throw new BaronError(
      'No provider is bound to the issues port. Set policy.providers.issues.',
      'PORT_UNBOUND',
    );
  }

  const roleMapEntry = policy.roleMap[provider];
  if (roleMapEntry === undefined) {
    throw new BaronError(
      `Issues provider '${provider}' has no role map. Add policy.roleMap.${provider}.`,
      'ROLE_MAP_MISSING',
    );
  }

  const typeMap = policy.typeMap[provider];
  if (typeMap === undefined) {
    throw new BaronError(
      `Issues provider '${provider}' has no type map. Add policy.typeMap.${provider}.`,
      'TYPE_MAP_MISSING',
    );
  }

  const roleMap: ProviderRoleMap = {
    stateKey: roleMapEntry.stateKey,
    states: roleMapEntry.states,
  };

  return {
    provider,
    roleMap,
    typeMap,
    gapPolicy: parseGapPolicy(policy.gapPolicy?.[provider] ?? {}),
  };
}
