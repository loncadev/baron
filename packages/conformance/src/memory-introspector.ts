import type { Introspector, ProviderIntrospection } from '@lonca/baron-core';

/**
 * In-memory stand-in for a provider introspector. It returns a fixed {@link ProviderIntrospection}
 * fixture so the role-map proposal and `baron init` flow can be exercised with zero network access;
 * the live SDK introspectors are validated separately by gated smoke tests.
 */
export function createMemoryIntrospector(fixture: ProviderIntrospection): Introspector {
  return {
    async introspect(): Promise<ProviderIntrospection> {
      return fixture;
    },
  };
}

/** Rich provider: arbitrary states, native hierarchy, a separate board, sprints (Azure-shaped). */
export const azureIntrospectionFixture: ProviderIntrospection = {
  provider: 'azure-devops',
  stateKey: 'state',
  workItemTypes: [
    { name: 'Epic', hierarchyLevel: 0 },
    { name: 'Feature', hierarchyLevel: 1 },
    { name: 'Product Backlog Item', hierarchyLevel: 2 },
    { name: 'Task', hierarchyLevel: 3 },
    { name: 'Bug', hierarchyLevel: 3 },
  ],
  states: [
    { name: 'New', category: 'proposed' },
    { name: 'Active', category: 'in_progress' },
    { name: 'Resolved', category: 'resolved' },
    { name: 'Closed', category: 'completed' },
    { name: 'Removed', category: 'removed' },
  ],
  boardColumns: ['New', 'In Progress', 'Test', 'Done'],
  iterations: ['Sprint 1', 'Sprint 2'],
};

/** Flat provider: binary open/closed states, one native type, no board or sprints (GitHub-shaped). */
export const githubIntrospectionFixture: ProviderIntrospection = {
  provider: 'github',
  stateKey: 'label',
  // 'issue' is what a GitHub item reports when no Issue Type is set — the default, not a fallback.
  workItemTypes: [{ name: 'issue', isDefault: true }],
  states: [
    { name: 'open', category: 'proposed' },
    { name: 'closed', category: 'completed' },
  ],
};

/**
 * Scoped provider: workflow states are owned by a team, so the same NAME is a different state in
 * each one and only the id identifies a single row (Linear-shaped).
 *
 * Two teams on purpose, and BETA has no review state — a role can legitimately exist in one scope
 * and not another, and anything that walks a scoped map has to survive that rather than treat it as
 * drift.
 */
export const scopedIntrospectionFixture: ProviderIntrospection = {
  provider: 'linear',
  stateKey: 'stateId',
  workItemTypes: [{ name: 'Issue', isDefault: true }],
  states: [
    { name: 'Backlog', category: 'proposed', value: 'alpha-backlog', scope: 'ALPHA' },
    { name: 'In Progress', category: 'in_progress', value: 'alpha-active', scope: 'ALPHA' },
    { name: 'Code Review', category: 'resolved', value: 'alpha-review', scope: 'ALPHA' },
    { name: 'Done', category: 'completed', value: 'alpha-done', scope: 'ALPHA' },
    { name: 'Backlog', category: 'proposed', value: 'beta-backlog', scope: 'BETA' },
    { name: 'In Progress', category: 'in_progress', value: 'beta-active', scope: 'BETA' },
    { name: 'Done', category: 'completed', value: 'beta-done', scope: 'BETA' },
  ],
};
