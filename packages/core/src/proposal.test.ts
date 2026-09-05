import { describe, expect, it } from 'vitest';
import type { CapabilityManifest } from './capabilities.js';
import type { ProviderIntrospection } from './introspection.js';
import { proposeGapPolicy, proposePolicy, proposeRoleMap, proposeTypeMap } from './proposal.js';
import { WORK_ITEM_TYPE_ROLES } from './roles.js';

const richManifest: CapabilityManifest = {
  provider: 'azure-devops',
  issues: {
    hierarchy: true,
    subIssues: false,
    separateBoardColumn: true,
    sprints: true,
    arbitraryStates: true,
    nativeLabels: true,
    nativeTypes: true,
    typeFiltering: true,
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
    nativeTypes: false,
    typeFiltering: false,
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

// A team-managed Jira project as its API reports it (2026-09-06, a real site): only three status
// categories, so the review state is `in_progress` too; statuses in no particular order, review
// first; and a "Subtask" type listed before "Task". Every one of those tripped the proposal.
const jiraIntrospection: ProviderIntrospection = {
  provider: 'jira',
  stateKey: 'status',
  workItemTypes: [
    { name: 'Epic', hierarchyLevel: 0 },
    { name: 'Subtask', hierarchyLevel: 1 },
    { name: 'Task', hierarchyLevel: 0 },
    { name: 'Story', hierarchyLevel: 0 },
    { name: 'Bug', hierarchyLevel: 0 },
  ],
  states: [
    { name: 'In Review', category: 'in_progress' },
    { name: 'In Progress', category: 'in_progress' },
    { name: 'Done', category: 'completed' },
    { name: 'To Do', category: 'proposed' },
  ],
};

const jiraManifest: CapabilityManifest = {
  ...richManifest,
  provider: 'jira',
  issues: { ...richManifest.issues, separateBoardColumn: false, sprints: false },
};

describe('proposeRoleMap (Jira: three categories, unordered states)', () => {
  it('does not hand in_progress a state that reads as review when a plainer one exists', () => {
    const { entry, notes } = proposeRoleMap(jiraIntrospection, jiraManifest);
    expect(entry.states.backlog).toEqual({ status: 'To Do' });
    expect(entry.states.in_progress).toEqual({ status: 'In Progress' });
    expect(entry.states.in_review).toEqual({ status: 'In Review' });
    expect(entry.states.done).toEqual({ status: 'Done' });
    expect(notes.some((n) => n.includes("Mapped role 'in_review' to state 'In Review'"))).toBe(
      true,
    );
  });

  it('still takes the only in_progress-category state when that is all there is', () => {
    const only: ProviderIntrospection = {
      ...jiraIntrospection,
      states: [
        { name: 'In Review', category: 'in_progress' },
        { name: 'Done', category: 'completed' },
        { name: 'To Do', category: 'proposed' },
      ],
    };
    const { entry } = proposeRoleMap(only, jiraManifest);
    expect(entry.states.in_progress).toEqual({ status: 'In Review' });
    expect(entry.states.in_review).toBeUndefined();
  });
});

describe('proposeTypeMap (Jira: Subtask listed before Task)', () => {
  it('maps task to Task and subtask to Subtask, never task onto the sub-task type', () => {
    const { typeMap, notes } = proposeTypeMap(jiraIntrospection);
    expect(typeMap.task).toBe('Task');
    expect(typeMap.subtask).toBe('Subtask');
    expect(typeMap.story).toBe('Story');
    expect(typeMap.bug).toBe('Bug');
    expect(typeMap.epic).toBe('Epic');
    expect(notes.some((n) => n.includes("Native type 'Task' is mapped from no type role"))).toBe(
      false,
    );
  });

  it('treats a sub-task-level type as no candidate for any other role, by level or by name', () => {
    const byName: ProviderIntrospection = {
      ...jiraIntrospection,
      workItemTypes: [{ name: 'Sub-task' }, { name: 'Story' }, { name: 'Bug' }],
    };
    const { typeMap } = proposeTypeMap(byName);
    expect(typeMap.subtask).toBe('Sub-task');
    // No "Task" here: task borrows from its neighbour rather than landing on the sub-task type.
    expect(typeMap.task).not.toBe('Sub-task');
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

  // A hole is not "that role is unavailable" — it is `issue.create` refusing a role the steering
  // block still advertises, discovered at the first run rather than at setup.
  it('leaves no type role unmapped, borrowing from the nearest neighbour', () => {
    const { typeMap, notes } = proposeTypeMap(richIntrospection);
    for (const role of WORK_ITEM_TYPE_ROLES) {
      expect(typeMap[role], `type role '${role}' is unmapped`).toBeDefined();
    }
    // No 'Initiative' or 'Sub-task' type exists on this provider, so each borrows from the nearest
    // role that matched: initiative -> epic, subtask -> task.
    expect(typeMap.initiative).toBe('Epic');
    expect(typeMap.subtask).toBe('Task');
    expect(notes.some((n) => n.includes("'initiative'"))).toBe(true);
  });

  // The regression that made task-start refuse every issue in Baron's own repository: an org had
  // Task/Bug/Feature defined and assigned to none of its issues, so all of them reported the plain
  // 'issue' type — which keyword matching mapped from nothing.
  it("maps the provider's default type when richer types exist but nothing matched it", () => {
    const { typeMap } = proposeTypeMap({
      provider: 'github',
      stateKey: 'label',
      workItemTypes: [
        { name: 'issue', isDefault: true },
        { name: 'Task' },
        { name: 'Bug' },
        { name: 'Feature' },
      ],
      states: [
        { name: 'open', category: 'proposed' },
        { name: 'closed', category: 'completed' },
      ],
    });
    expect(Object.values(typeMap)).toContain('issue');
    expect(typeMap.task).toBe('Task');
    expect(typeMap.bug).toBe('Bug');
    expect(typeMap.epic).toBe('Feature');
    for (const role of WORK_ITEM_TYPE_ROLES) {
      expect(typeMap[role], `type role '${role}' is unmapped`).toBeDefined();
    }
  });

  it('notes a native type that no type role maps back from', () => {
    const { notes } = proposeTypeMap({
      provider: 'acme',
      stateKey: 'state',
      workItemTypes: [{ name: 'Task' }, { name: 'Bug' }, { name: 'Spike' }],
      states: [{ name: 'New', category: 'proposed' }],
    });
    expect(notes.some((n) => n.includes("'Spike'") && n.includes('canonical branch'))).toBe(true);
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
