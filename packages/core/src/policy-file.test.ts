import { describe, expect, it } from 'vitest';
import { BaronError } from './errors.js';
import {
  type BaronPolicyFile,
  parsePolicy,
  resolveIssuesConfig,
  serializePolicy,
} from './policy-file.js';

const validPolicy: BaronPolicyFile = {
  version: 1,
  providers: { issues: 'azure-devops', scm: 'github', notify: 'slack' },
  roleMap: {
    'azure-devops': {
      stateKey: 'state',
      states: {
        backlog: { state: 'New' },
        in_progress: { state: 'Active', boardColumn: 'In Progress' },
        in_review: { state: 'Test', boardColumn: 'Test' },
        done: { state: 'Closed' },
      },
    },
    github: {
      stateKey: 'label',
      states: {
        in_progress: { label: 'in-progress' },
        done: { state: 'closed', label: 'done' },
      },
    },
  },
  typeMap: {
    'azure-devops': { epic: 'Epic', story: 'Product Backlog Item', task: 'Task' },
    github: { epic: 'issue', story: 'issue', task: 'issue' },
  },
  gapPolicy: {
    github: { hierarchy: 'emulate:labels', sprints: 'degrade' },
  },
  language: { interaction: 'tr', artifacts: 'en' },
};

describe('parsePolicy', () => {
  it('accepts a well-formed policy and is stable under JSON round-trip', () => {
    const parsed = parsePolicy(JSON.parse(JSON.stringify(validPolicy)));
    expect(parsed).toEqual(validPolicy);
  });

  it('rejects a wrong version', () => {
    expect(() => parsePolicy({ ...validPolicy, version: 2 })).toThrow(BaronError);
  });

  it('rejects a non-object root', () => {
    expect(() => parsePolicy(null)).toThrow(/must be an object/);
    expect(() => parsePolicy([])).toThrow(/must be an object/);
  });

  it('rejects an unknown port binding', () => {
    expect(() => parsePolicy({ ...validPolicy, providers: { tickets: 'azure-devops' } })).toThrow(
      /unknown port 'tickets'/,
    );
  });

  it('rejects an unknown workflow role in a role map', () => {
    expect(() =>
      parsePolicy({
        ...validPolicy,
        roleMap: { github: { stateKey: 'label', states: { shipped: { label: 'x' } } } },
      }),
    ).toThrow(/unknown workflow role 'shipped'/);
  });

  it('rejects a missing stateKey', () => {
    expect(() =>
      parsePolicy({
        ...validPolicy,
        roleMap: { github: { states: { done: { state: 'closed' } } } },
      }),
    ).toThrow(/stateKey must be a non-empty string/);
  });

  it('rejects an unknown type role', () => {
    expect(() => parsePolicy({ ...validPolicy, typeMap: { github: { widget: 'issue' } } })).toThrow(
      /unknown type role 'widget'/,
    );
  });

  it('rejects a non-string native target value', () => {
    expect(() =>
      parsePolicy({
        ...validPolicy,
        roleMap: { github: { stateKey: 'label', states: { done: { label: 42 } } } },
      }),
    ).toThrow(/must be a string/);
  });

  it('treats gapPolicy and language as optional', () => {
    const minimal = {
      version: 1,
      providers: { issues: 'github' },
      roleMap: { github: { stateKey: 'label', states: { done: { state: 'closed' } } } },
      typeMap: { github: { task: 'issue' } },
    };
    const parsed = parsePolicy(minimal);
    expect(parsed.gapPolicy).toBeUndefined();
    expect(parsed.language).toBeUndefined();
  });
});

describe('serializePolicy', () => {
  it('produces indented JSON with a trailing newline that re-parses to the same policy', () => {
    const text = serializePolicy(validPolicy);
    expect(text.endsWith('}\n')).toBe(true);
    expect(parsePolicy(JSON.parse(text))).toEqual(validPolicy);
  });
});

describe('resolveIssuesConfig', () => {
  it('projects the issues-bound provider into an IssuesProviderConfig', () => {
    const cfg = resolveIssuesConfig(validPolicy);
    expect(cfg.provider).toBe('azure-devops');
    expect(cfg.roleMap.stateKey).toBe('state');
    expect(cfg.roleMap.states.in_review).toEqual({ state: 'Test', boardColumn: 'Test' });
    expect(cfg.typeMap.story).toBe('Product Backlog Item');
  });

  it('parses the bound provider gap policy into structured behaviors', () => {
    const cfg = resolveIssuesConfig({ ...validPolicy, providers: { issues: 'github' } });
    expect(cfg.gapPolicy.hierarchy).toEqual({ kind: 'emulate', strategy: 'labels' });
    expect(cfg.gapPolicy.sprints).toEqual({ kind: 'degrade' });
  });

  it('defaults to an empty gap policy when the provider has none', () => {
    const cfg = resolveIssuesConfig(validPolicy);
    expect(cfg.gapPolicy).toEqual({});
  });

  it('throws when the issues port is unbound', () => {
    expect(() => resolveIssuesConfig({ ...validPolicy, providers: {} })).toThrow(/issues port/);
  });

  it('throws when the bound provider has no role map', () => {
    expect(() => resolveIssuesConfig({ ...validPolicy, providers: { issues: 'linear' } })).toThrow(
      /no role map/,
    );
  });
});
