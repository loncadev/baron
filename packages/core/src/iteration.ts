/**
 * A normalized iteration/sprint, independent of the backing provider (Azure Boards iterations; a
 * Jira/Linear sprint; GitHub has none natively). Iteration is a dimension of the `issues` port —
 * you assign a work ITEM to one and query ITEMS by one — gated by the `sprints` capability, not a
 * separate port.
 */
export interface Iteration {
  /** Provider-native id (Azure iteration guid/id). */
  readonly id: string;
  /** Human name, e.g. "Sprint 2". */
  readonly name: string;
  /** The assignment key (Azure `System.IterationPath`, e.g. "Project\\Sprint 2"). */
  readonly path: string;
  readonly startDate?: string | undefined;
  readonly finishDate?: string | undefined;
  /** Whether this is the active iteration right now (by the provider's dates). */
  readonly current: boolean;
}

/**
 * Sentinel meaning "the active iteration" for {@link IssuesPort.setIteration} and
 * {@link IssueQuery.iteration} — resolved to the current iteration's path by the core.
 */
export const ITERATION_CURRENT = '@current';
