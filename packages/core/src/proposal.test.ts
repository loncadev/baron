import { describe, expect, it } from 'vitest';
import type { CapabilityManifest } from './capabilities.js';
import type { ProviderIntrospection } from './introspection.js';
import { proposeGapPolicy, proposePolicy, proposeRoleMap, proposeTypeMap } from './proposal.js';

const richManifest: CapabilityManifest = {
  provider: 'azure-devops',
  issues: {
    hierarchy: true,
    subIssues: false,
    separateBoardColumn: true,
    sprints: true,
    arbitraryStates: true,
    nativeLabels: true,
    comments: true,
    issueLinks: true,
    assignment: true,
  },
};

const richIntrospection: ProviderIntrospection = {
  provider: 'azure-devops',
  stateKey: 'state',
  workItemTypes: [{ name: 'Epic' }, { name: 'Product Backlog Item' }, { name: 'Task' }],
  states: [
    { name: 'New', category: 'proposed' },
    { name: 'Active', category: 'in_progress' },
    { name: 'Resolved', category: 'resolved' },
    { name: 'Closed', category: 'completed' },
  ],
  boardColumns: ['New', 'In Progress', 'Test', 'Done'],
  iterations: ['Sprint 1'],
};

const flatManifest: CapabilityManifest = {
  provider: 'github',
  issues: {
    hierarchy: false,
    subIssues: true,
    separateBoardColumn: false,
    sprints: false,
    arbitraryStates: false,
    nativeLabels: true,
    comments: true,
    issueLinks: false,
    assignment: true,
  },
};

const flatIntrospection: ProviderIntrospection = {
  provider: 'github',
  stateKey: 'label',
  workItemTypes: [{ name: 'issue' }],
  states: [
    { name: 'open', category: 'proposed' },
    { name: 'closed', category: 'completed' },
  ],
};

// A customized Scrum process (BeeMaster-shaped): the review state is 'Test' in the InProgress
// category (no 'resolved'-category state), and the portfolio types include both Feature and PBI.
const scrumIntrospection: ProviderIntrospection = {
  provider: 'azure-devops',
  stateKey: 'state',
  workItemTypes: [
    { name: 'Epic' },
    { name: 'Feature' },
    { name: 'Product Backlog Item' },
    { name: 'Task' },
  ],
  states: [
    { name: 'New', category: 'proposed' },
    { name: 'Active', category: 'in_progress' },
    { name: 'Test', category: 'in_progress' },
    { name: 'Closed', category: 'completed' },
  ],
};

describe('proposeRoleMap (customized Scrum: in_review by state name)', () => {
  it("maps in_review to a 'Test' state by name when no resolved-category state exists", () => {
    const { entry } = proposeRoleMap(scrumIntrospection, richManifest);
    expect(entry.states.backlog).toEqual({ state: 'New' });
    expect(entry.states.in_progress).toEqual({ state: 'Active' });
    expect(entry.states.in_review).toEqual({ state: 'Test' });
    expect(entry.states.done).toEqual({ state: 'Closed' });
  });

  it('does not reuse the in_progress state for in_review', () => {
    const { entry } = proposeRoleMap(scrumIntrospection, richManifest);
    expect(entry.states.in_review?.state).not.toBe(entry.states.in_progress?.state);
  });
});

describe('proposeTypeMap (Feature vs Product Backlog Item)', () => {
  it('maps story to the backlog item, not Feature, and Feature-as-epic', () => {
    const { typeMap } = proposeTypeMap(scrumIntrospection);
    expect(typeMap.story).toBe('Product Backlog Item');
    expect(typeMap.epic).toBe('Epic');
    expect(typeMap.task).toBe('Task');
  });
});

describe('proposeRoleMap (rich provider)', () => {
  it('draws each role from a native state by category and attaches matching board columns', () => {
    const { entry } = proposeRoleMap(richIntrospection, richManifest);
    expect(entry.stateKey).toBe('state');
    expect(entry.states.backlog).toEqual({ state: 'New' });
    expect(entry.states.in_progress).toEqual({ state: 'Active', boardColumn: 'In Progress' });
    expect(entry.states.in_review).toEqual({ state: 'Resolved', boardColumn: 'Test' });
    expect(entry.states.done).toEqual({ state: 'Closed', boardColumn: 'Done' });
  });

  it('notes a role with no matching state instead of inventing one', () => {
    const intro: ProviderIntrospection = {
      ...richIntrospection,
      states: [{ name: 'Active', category: 'in_progress' }],
    };
    const { entry, notes } = proposeRoleMap(intro, richManifest);
    expect(entry.states.done).toBeUndefined();
    expect(notes.some((n) => n.includes("'done'"))).toBe(true);
  });
});

describe('proposeRoleMap (flat provider)', () => {
  it('rides mid-workflow roles on labels and closes the issue for done', () => {
    const { entry, notes } = proposeRoleMap(flatIntrospection, flatManifest);
    expect(entry.stateKey).toBe('label');
    expect(entry.states.in_progress).toEqual({ label: 'in-progress' });
    expect(entry.states.in_review).toEqual({ label: 'in-review' });
    expect(entry.states.done).toEqual({ state: 'closed', label: 'done' });
    expect(entry.states.backlog).toBeUndefined();
    expect(notes.length).toBeGreaterThan(0);
  });
});

describe('proposeTypeMap', () => {
  it('matches each type role by keyword on a multi-type provider', () => {
    const { typeMap } = proposeTypeMap(richIntrospection);
    expect(typeMap.epic).toBe('Epic');
    expect(typeMap.story).toBe('Product Backlog Item');
    expect(typeMap.task).toBe('Task');
  });

  it('collapses all type roles onto the single native type and notes the loss', () => {
    const { typeMap, notes } = proposeTypeMap(flatIntrospection);
    expect(typeMap.epic).toBe('issue');
    expect(typeMap.task).toBe('issue');
    expect(notes.some((n) => n.includes('lossy'))).toBe(true);
  });
});

describe('proposeGapPolicy', () => {
  it('proposes an explicit behavior for each unsupported capability', () => {
    const { gapPolicy } = proposeGapPolicy(flatManifest);
    expect(gapPolicy.hierarchy).toBe('emulate:labels');
    expect(gapPolicy.arbitraryStates).toBe('emulate:labels');
    expect(gapPolicy.sprints).toBe('degrade');
    expect(gapPolicy.subIssues).toBeUndefined(); // supported -> no gap
  });

  it('proposes nothing for a fully capable provider', () => {
    const { gapPolicy } = proposeGapPolicy(richManifest);
    expect(gapPolicy.hierarchy).toBeUndefined();
    expect(gapPolicy.arbitraryStates).toBeUndefined();
    expect(gapPolicy.subIssues).toBe('degrade'); // the one gap Azure has
  });
});

describe('proposePolicy', () => {
  it('assembles role map, type map, gap policy, and merged notes', () => {
    const proposal = proposePolicy(flatIntrospection, flatManifest);
    expect(proposal.provider).toBe('github');
    expect(proposal.roleMap.stateKey).toBe('label');
    expect(proposal.typeMap.task).toBe('issue');
    expect(proposal.gapPolicy.hierarchy).toBe('emulate:labels');
    expect(proposal.notes.length).toBeGreaterThan(0);
  });
});
