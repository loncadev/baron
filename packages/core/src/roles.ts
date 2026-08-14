/**
 * Abstract workflow roles: where a work item is in its lifecycle. Providers map their native
 * states/columns/labels onto these so that recipes and primitives can speak one language regardless
 * of the backing provider.
 *
 *   backlog -> ready -> in_progress -> in_review -> done
 *
 * `blocked` is deliberately NOT here. It answers a different question — "can this move?" rather than
 * "where is it?" — and modelling it as a role made the two mutually exclusive: transitioning to
 * blocked overwrote the role, so nothing recorded whether the item had been in_progress or in_review,
 * and unblocking had nowhere to return to. Jira, Linear and GitLab all keep it separate. It lives on
 * the item as an orthogonal flag ({@link BLOCKED_LABEL}) that coexists with whatever role the item
 * holds.
 */
export const WORKFLOW_ROLES = ['backlog', 'ready', 'in_progress', 'in_review', 'done'] as const;

/**
 * What a move from one workflow role to another IS, against the ordered lifecycle above.
 *
 * The order is core vocabulary — `WORKFLOW_ROLES` is a sequence, not a set — so naming a move is a
 * fact about the lifecycle rather than an opinion about it. What to DO about a `regress` (the
 * reference asks for a recorded reason) is workflow opinion and stays in a recipe, which is the line
 * invariant #3 draws.
 */
export const ROLE_MOVES = ['advance', 'regress', 'reopen', 'noop', 'unknown'] as const;

export type RoleMove = (typeof ROLE_MOVES)[number];

/**
 * Classify a move. `unknown` when the item's current role cannot be read at all — an unmapped state
 * or a cold read — because guessing there would let a guard fire on nothing, or fail to.
 */
export function classifyRoleMove(from: WorkflowRole | undefined, to: WorkflowRole): RoleMove {
  if (from === undefined) return 'unknown';
  if (from === to) return 'noop';
  // Leaving the terminal role is its own thing: it is not a step backwards along the line, it is
  // reopening finished work, and the two deserve different words in a message a human reads.
  if (from === WORKFLOW_ROLES[WORKFLOW_ROLES.length - 1]) return 'reopen';
  return WORKFLOW_ROLES.indexOf(to) > WORKFLOW_ROLES.indexOf(from) ? 'advance' : 'regress';
}

/**
 * The label carrying the orthogonal blocked flag. A Baron-managed constant rather than policy, like
 * the `type:<role>` and `parent:<id>` emulation labels — it names a fact about the item, not a
 * mapping onto anything the provider already has.
 */
export const BLOCKED_LABEL = 'blocked';

export type WorkflowRole = (typeof WORKFLOW_ROLES)[number];

export function isWorkflowRole(value: string): value is WorkflowRole {
  return (WORKFLOW_ROLES as readonly string[]).includes(value);
}

/**
 * Abstract work-item type roles. A provider maps these onto its native types
 * (Azure: Epic/Feature/Product Backlog Item/Task/Bug; GitHub: a flat issue + labels).
 */
export const WORK_ITEM_TYPE_ROLES = [
  'initiative',
  'epic',
  'story',
  'task',
  'bug',
  'subtask',
] as const;

export type WorkItemTypeRole = (typeof WORK_ITEM_TYPE_ROLES)[number];

export function isWorkItemTypeRole(value: string): value is WorkItemTypeRole {
  return (WORK_ITEM_TYPE_ROLES as readonly string[]).includes(value);
}

/**
 * When a provider has no native type for a role, whose native type it borrows — in preference
 * order, nearest neighbour first. Abstract knowledge about the roles themselves, so it lives here
 * rather than in any adapter or in the proposal's provider-facing keyword table.
 *
 * The point is coverage. A role left unmapped is not a harmless omission: `issue.create` refuses it,
 * and an item whose native type maps to no role reports no type role at all, which costs it its
 * canonical branch. Collapsing is lossy and always noted; leaving a hole is lossy AND silent until
 * something fails.
 */
export const TYPE_ROLE_COLLAPSE_ORDER: Readonly<
  Record<WorkItemTypeRole, readonly WorkItemTypeRole[]>
> = {
  initiative: ['epic', 'story', 'task'],
  epic: ['initiative', 'story', 'task'],
  story: ['task', 'epic', 'bug'],
  task: ['story', 'subtask', 'bug'],
  bug: ['task', 'story'],
  subtask: ['task', 'story'],
};
