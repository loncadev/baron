/**
 * What an `issues` adapter supports. The core consults this before every operation and applies
 * the configured gap policy for any capability that is `false`. Adding a new capability here is a
 * deliberate, reviewed change because it widens the contract every adapter must answer for.
 */
export interface IssuesCapabilities {
  /** Native parent/child links between work items (Azure: yes; GitHub issues: no). */
  hierarchy: boolean;
  /** Native sub-issue / checklist-item primitive distinct from full hierarchy. */
  subIssues: boolean;
  /** A board column distinct from workflow state (Azure Boards: yes; most others: no). */
  separateBoardColumn: boolean;
  /** Iteration/sprint assignment. */
  sprints: boolean;
  /**
   * Arbitrary, provider-defined workflow states beyond binary open/closed.
   * Azure (New/Active/Test/Closed) = true; GitHub (open/closed) = false.
   */
  arbitraryStates: boolean;
  /** First-class labels/tags. */
  nativeLabels: boolean;
  /**
   * The provider persists a work-item type chosen at create time and reports it back. Azure: yes.
   * GitHub: no — `issues.create` accepts no type, so every item reads back as the untyped default
   * however the type map is written, and the abstract type role has to ride a `type:<role>` label
   * instead. This is what the label gate must ask; "do several roles share this native type?" is a
   * different question, and answering that one instead dropped the label from every GitHub bug the
   * moment the type map stopped collapsing.
   */
  nativeTypes: boolean;
  /**
   * The provider's own query can filter by work-item type. Azure: yes (a WIQL
   * `[System.WorkItemType] = …` clause). GitHub: no — `listForRepo` takes labels, state and
   * assignee, and nothing else, so a type filter handed to it is simply ignored and the caller gets
   * every item back believing it asked for one kind.
   */
  typeFiltering: boolean;
  /** Comments/discussion on a work item. */
  comments: boolean;
  /**
   * Native, typed links between work items beyond hierarchy (relates / blocks / duplicates).
   * Azure: yes (System.LinkTypes.*); GitHub issues: no (must be emulated or degraded).
   */
  issueLinks: boolean;
  /** Assigning a work item to a user (Azure: System.AssignedTo; GitHub: assignees). */
  assignment: boolean;
}

export type CapabilityName = keyof IssuesCapabilities;

/** Self-description an adapter exposes so the core can negotiate gaps instead of failing blindly. */
export interface CapabilityManifest {
  provider: string;
  issues: IssuesCapabilities;
}
