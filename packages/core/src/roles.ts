/**
 * Abstract workflow roles. Providers map their native states/columns/labels onto these so that
 * recipes and primitives can speak one language regardless of the backing provider.
 *
 *   backlog -> ready -> in_progress -> in_review -> done
 *                            |
 *                          blocked  (orthogonal)
 */
export const WORKFLOW_ROLES = [
  'backlog',
  'ready',
  'in_progress',
  'in_review',
  'blocked',
  'done',
] as const;

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
