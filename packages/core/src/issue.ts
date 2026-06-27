import type { WorkItemTypeRole, WorkflowRole } from './roles.js';

/** A normalized issue as Baron exposes it, independent of the backing provider. */
export interface Issue {
  readonly id: string;
  /** Human-facing reference (Azure 'AB#123', GitHub '#42'). */
  readonly key: string;
  readonly title: string;
  readonly body?: string | undefined;
  readonly nativeType: string;
  /** Resolved abstract type role, or undefined if the native type is unmapped. */
  readonly typeRole?: WorkItemTypeRole | undefined;
  /** Resolved workflow role, or undefined if the native state is unmapped. */
  readonly role?: WorkflowRole | undefined;
  /** The raw provider discriminator the role was resolved from. */
  readonly nativeState: string;
  readonly parentId?: string | undefined;
  readonly labels: readonly string[];
  readonly url?: string | undefined;
  readonly provider: string;
}

/** A normalized comment on an issue, independent of the backing provider. */
export interface IssueComment {
  readonly id: string;
  readonly body: string;
  readonly author?: string | undefined;
  /** ISO-8601 creation timestamp, when the provider supplies one. */
  readonly createdAt?: string | undefined;
  readonly url?: string | undefined;
}

/** Filter for `issue.query`, expressed in abstract terms. All fields are optional (AND-combined). */
export interface IssueQuery {
  readonly role?: WorkflowRole | undefined;
  readonly typeRole?: WorkItemTypeRole | undefined;
  readonly limit?: number | undefined;
}

/** Input to `issue.create`, expressed in abstract terms. */
export interface IssueDraft {
  readonly title: string;
  readonly body?: string | undefined;
  readonly typeRole: WorkItemTypeRole;
  readonly parentId?: string | undefined;
  readonly labels?: readonly string[] | undefined;
  /** Optional starting workflow role; otherwise the provider default applies. */
  readonly initialRole?: WorkflowRole | undefined;
}
