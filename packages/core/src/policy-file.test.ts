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

// `blocked` stopped being a workflow role. A policy written when it was one must keep loading — the
// alternative is bricking a working install over a vocabulary change — but the correction has to be
// visible, or the file on disk silently disagrees with what Baron is doing forever.
describe('legacy blocked role migration', () => {
  const legacy = {
    version: 1,
    providers: { issues: 'github' },
    roleMap: {
      github: {
        stateKey: 'label',
        states: {
          in_progress: { label: 'in-progress' },
          blocked: { label: 'is-blocked' },
          done: { state: 'closed', label: 'done' },
        },
      },
    },
    typeMap: { github: { task: 'issue' } },
  };

  it('drops the blocked entry instead of rejecting the policy', () => {
    const parsed = parsePolicy(legacy);
    expect(parsed.roleMap.github?.states).not.toHaveProperty('blocked');
    expect(parsed.roleMap.github?.states.in_progress).toEqual({ label: 'in-progress' });
  });

  it('reports what it migrated, naming the value it dropped', () => {
    const parsed = parsePolicy(legacy);
    expect(parsed.migrations?.length).toBe(1);
    expect(parsed.migrations?.[0]).toContain('is-blocked');
    expect(parsed.migrations?.[0]).toContain('orthogonal');
  });

  it('never writes the migration note back to disk', () => {
    const parsed = parsePolicy(legacy);
    expect(serializePolicy(parsed)).not.toContain('migrations');
    // and re-parsing what was written reports nothing left to migrate
    expect(parsePolicy(JSON.parse(serializePolicy(parsed))).migrations).toBeUndefined();
  });

  it('still rejects a role that is not merely legacy', () => {
    expect(() =>
      parsePolicy({ ...legacy, roleMap: { github: { stateKey: 'label', states: { nope: {} } } } }),
    ).toThrow(/unknown workflow role/);
  });
});

// Every sibling level rejects a key it does not know; this one destructured what it wanted and
// dropped the rest, so a hand-written `scope` — the thing #16 is about — parsed cleanly and vanished.
describe('unknown key on a role-map entry', () => {
  const withScope = {
    version: 1,
    providers: { issues: 'linear' },
    roleMap: {
      linear: {
        stateKey: 'stateId',
        states: { in_progress: { stateId: 'uuid-abc' } },
        scope: 'ENG-team',
      },
    },
    typeMap: { linear: { task: 'Issue' } },
  };

  it('fails loudly instead of silently discarding it', () => {
    expect(() => parsePolicy(withScope)).toThrow(/roleMap\.linear has unknown key 'scope'/);
  });

  it('names the keys that ARE allowed, so the message is actionable', () => {
    expect(() => parsePolicy(withScope)).toThrow(/stateKey, states/);
  });

  // The half of #16 that needs no core change: NativeTarget is an open record and stateKey names
  // whichever key discriminates, so a map keyed on opaque state IDs already round-trips.
  it('still accepts a role map keyed on opaque state ids rather than names', () => {
    const { scope: _rejected, ...entry } = withScope.roleMap.linear;
    const parsed = parsePolicy({ ...withScope, roleMap: { linear: entry } });
    expect(parsed.roleMap.linear?.stateKey).toBe('stateId');
    expect(parsed.roleMap.linear?.states.in_progress).toEqual({ stateId: 'uuid-abc' });
  });
});

describe('scoped role maps', () => {
  const scoped = (scopes: unknown) => ({
    version: 1,
    providers: { issues: 'linear' },
    roleMap: { linear: { stateKey: 'stateId', states: {}, scopes } },
    typeMap: { linear: { task: 'Task' } },
  });

  it('parses a per-scope map, which a flat map cannot express', () => {
    // Linear's WorkflowState.team is non-null, so the same role is a different state id per team.
    const policy = parsePolicy(
      scoped({
        KSP: { in_progress: { stateId: 'ksp-1' } },
        BAR: { in_progress: { stateId: 'bar-1' }, in_review: { stateId: 'bar-2' } },
      }),
    );
    const map = policy.roleMap.linear;
    expect(map?.scopes?.KSP?.in_progress).toEqual({ stateId: 'ksp-1' });
    expect(map?.scopes?.BAR?.in_review).toEqual({ stateId: 'bar-2' });
    // A role present in one scope and absent in another is legitimate, not an error.
    expect(map?.scopes?.KSP?.in_review).toBeUndefined();
  });

  it('holds a scope to the same rules as the default map', () => {
    // The unknown-key guard on roleMap existed precisely so a hand-written scope could not parse
    // cleanly and vanish. Reusing one validator means a bad role inside a scope cannot either.
    expect(() => parsePolicy(scoped({ KSP: { nonsense: { stateId: 'x' } } }))).toThrow(
      /unknown workflow role 'nonsense'/,
    );
  });

  it('refuses a scope that maps nothing, rather than reporting every role unmapped later', () => {
    expect(() => parsePolicy(scoped({ KSP: {} }))).toThrow(/maps no roles/);
  });
});
