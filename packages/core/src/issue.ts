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
