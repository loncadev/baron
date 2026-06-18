import { describe, expect, it } from 'vitest';
import type { ProviderRoleMap } from './config.js';
import { RoleMappingError } from './errors.js';
import { RoleResolver } from './role-resolver.js';

const azureMap: ProviderRoleMap = {
  stateKey: 'state',
  states: {
    in_progress: { state: 'Active', boardColumn: 'In Progress' },
    in_review: { state: 'Test', boardColumn: 'Test' },
    done: { state: 'Closed' },
  },
};

const githubMap: ProviderRoleMap = {
  stateKey: 'label',
  states: {
    in_progress: { label: 'in-progress' },
    in_review: { label: 'in-review' },
    done: { state: 'closed', label: 'done' },
  },
};

describe('RoleResolver.toNative', () => {
  it('maps a role to the provider-native target', () => {
    const r = new RoleResolver(azureMap, 'azure-devops');
    expect(r.toNative('in_progress')).toEqual({ state: 'Active', boardColumn: 'In Progress' });
  });

  it('throws RoleMappingError for an unmapped role', () => {
    const r = new RoleResolver(azureMap, 'azure-devops');
    expect(() => r.toNative('blocked')).toThrow(RoleMappingError);
  });
});

describe('RoleResolver.toRole (reverse via stateKey)', () => {
  it('resolves Azure native state through the state key', () => {
    const r = new RoleResolver(azureMap, 'azure-devops');
    expect(r.toRole('Active')).toBe('in_progress');
    expect(r.toRole('Closed')).toBe('done');
  });

  it('resolves GitHub through the label key, not the state key', () => {
    const r = new RoleResolver(githubMap, 'github');
    expect(r.toRole('in-review')).toBe('in_review');
    // 'closed' lives under the `state` key, which is NOT GitHub's discriminator -> no match.
    expect(r.toRole('closed')).toBeUndefined();
    expect(r.toRole('done')).toBe('done');
  });

  it('returns undefined for an unknown native value', () => {
    const r = new RoleResolver(azureMap, 'azure-devops');
    expect(r.toRole('Frobnicated')).toBeUndefined();
  });
});

describe('RoleResolver.has', () => {
  it('reports mapping presence without throwing', () => {
    const r = new RoleResolver(azureMap, 'azure-devops');
    expect(r.has('in_progress')).toBe(true);
    expect(r.has('blocked')).toBe(false);
  });
});
