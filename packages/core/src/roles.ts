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
 * (Azure: Epic/Feature/Product Backlog Item/Task; GitHub: a flat issue + labels).
 */
export const WORK_ITEM_TYPE_ROLES = ['initiative', 'epic', 'story', 'task', 'subtask'] as const;

export type WorkItemTypeRole = (typeof WORK_ITEM_TYPE_ROLES)[number];

export function isWorkItemTypeRole(value: string): value is WorkItemTypeRole {
  return (WORK_ITEM_TYPE_ROLES as readonly string[]).includes(value);
}
