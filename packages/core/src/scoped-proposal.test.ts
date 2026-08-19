import { describe, expect, it } from 'vitest';
import type { CapabilityManifest, ProviderIntrospection } from './index.js';
import { proposeRoleMap } from './proposal.js';

/** Two teams whose states share NAMES but not identity — the shape Linear actually returns. */
const introspection: ProviderIntrospection = {
  provider: 'linear',
  stateKey: 'stateId',
  workItemTypes: [{ name: 'Issue' }],
  states: [
    { name: 'Backlog', category: 'proposed', value: 'ksp-backlog', scope: 'KSP' },
    { name: 'In Progress', category: 'in_progress', value: 'ksp-in-progress', scope: 'KSP' },
    { name: 'Done', category: 'completed', value: 'ksp-done', scope: 'KSP' },
    { name: 'Backlog', category: 'proposed', value: 'bar-backlog', scope: 'BAR' },
    { name: 'In Progress', category: 'in_progress', value: 'bar-in-progress', scope: 'BAR' },
    { name: 'Code Review', category: 'in_progress', value: 'bar-code-review', scope: 'BAR' },
    { name: 'Done', category: 'completed', value: 'bar-done', scope: 'BAR' },
  ],
};

const manifest: CapabilityManifest = {
  provider: 'linear',
  issues: {
    hierarchy: true,
    subIssues: true,
    separateBoardColumn: false,
    sprints: true,
    arbitraryStates: true,
    nativeLabels: true,
    nativeTypes: false,
    typeFiltering: false,
    comments: true,
    issueLinks: true,
    assignment: true,
  },
};

describe('proposing a role map for a provider whose states are scoped', () => {
  it('proposes one map per scope, keyed by the state id rather than the name', () => {
    const { entry } = proposeRoleMap(introspection, manifest);
    // The names collide across teams, so a proposal keyed on them would be ambiguous at best and
    // silently wrong at worst — every role in one team pointing at another team's row.
    expect(entry.scopes?.KSP?.in_progress).toEqual({ stateId: 'ksp-in-progress' });
    expect(entry.scopes?.BAR?.in_progress).toEqual({ stateId: 'bar-in-progress' });
    // The flat map stays empty: on a scoped provider it belongs to no team, so anything in it would
    // be one team's states imposed on all of them.
    expect(entry.states).toEqual({});
  });

  it('lets a role exist in one scope and not another', () => {
    const { entry } = proposeRoleMap(introspection, manifest);
    // BAR has a review state; KSP does not. That is a legitimate difference between two teams, not
    // an incomplete map, and forcing symmetry would invent a state KSP does not have.
    expect(entry.scopes?.BAR?.in_review).toEqual({ stateId: 'bar-code-review' });
    expect(entry.scopes?.KSP?.in_review).toBeUndefined();
  });

  it('says in its notes that the map is scoped, so the confirmation screen is not a surprise', () => {
    const { notes } = proposeRoleMap(introspection, manifest);
    expect(notes.join('\n')).toMatch(/scoped/i);
    expect(notes.join('\n')).toContain('KSP');
  });

  it('leaves an unscoped provider exactly as it was', () => {
    // The whole design rests on this: Azure and GitHub must not notice the feature exists.
    const flat: ProviderIntrospection = {
      provider: 'azure-devops',
      stateKey: 'state',
      workItemTypes: [{ name: 'Task' }],
      states: [
        { name: 'New', category: 'proposed' },
        { name: 'Active', category: 'in_progress' },
        { name: 'Closed', category: 'completed' },
      ],
    };
    const { entry } = proposeRoleMap(flat, { ...manifest, provider: 'azure-devops' });
    expect(entry.scopes).toBeUndefined();
    expect(entry.states.in_progress).toEqual({ state: 'Active' });
  });
});
