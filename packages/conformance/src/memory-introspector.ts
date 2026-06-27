import type { Introspector, ProviderIntrospection } from '@baron/core';

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
  workItemTypes: [{ name: 'issue' }],
  states: [
    { name: 'open', category: 'proposed' },
    { name: 'closed', category: 'completed' },
  ],
};
