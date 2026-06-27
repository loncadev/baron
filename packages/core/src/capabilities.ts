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
  /** Comments/discussion on a work item. */
  comments: boolean;
  /**
   * Native, typed links between work items beyond hierarchy (relates / blocks / duplicates).
   * Azure: yes (System.LinkTypes.*); GitHub issues: no (must be emulated or degraded).
   */
  issueLinks: boolean;
}

export type CapabilityName = keyof IssuesCapabilities;

/** Self-description an adapter exposes so the core can negotiate gaps instead of failing blindly. */
export interface CapabilityManifest {
  provider: string;
  issues: IssuesCapabilities;
}
