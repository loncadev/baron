/**
 * The provider-native vocabulary `baron init` reads before proposing a role map. An adapter
 * contributes an {@link Introspector} (provider I/O, like the transport); all translation of this
 * vocabulary into abstract roles lives in the pure proposal logic (see `proposal.ts`), never in the
 * adapter — the same invariant that keeps the transport free of mapping logic.
 */

/**
 * Provider-declared lifecycle bucket for a native state. Modelled on Azure Boards state
 * categories (the principled signal a rich provider exposes); flat providers map open/closed onto
 * `proposed`/`completed`. `unknown` means the provider gave no hint and a human must decide.
 */
export const STATE_CATEGORIES = [
  'proposed',
  'in_progress',
  'resolved',
  'completed',
  'removed',
  'unknown',
] as const;

export type StateCategory = (typeof STATE_CATEGORIES)[number];

export function isStateCategory(value: string): value is StateCategory {
  return (STATE_CATEGORIES as readonly string[]).includes(value);
}

export interface IntrospectedState {
  /** Native state name as the provider spells it (Azure 'Active', GitHub 'closed'). */
  readonly name: string;
  /** The provider's own lifecycle categorization, when it exposes one. */
  readonly category?: StateCategory | undefined;
  /**
   * The value that identifies this state in a {@link NativeTarget}, when the name will not do.
   *
   * Linear needs it: its states are owned by a team, so "In Progress" names a different row in each
   * one and only the id picks a single state. Absent where the name is the identity, which is every
   * provider whose states belong to the whole project.
   */
  readonly value?: string | undefined;
  /**
   * Which scope owns this state, on a provider that scopes them (a Linear team key).
   *
   * Reported per state rather than as a separate list of scopes so the flat shape survives: a
   * provider that does not scope simply leaves it unset and every existing reader is unaffected.
   */
  readonly scope?: string | undefined;
}

export interface IntrospectedType {
  /** Native work-item type name (Azure 'Product Backlog Item', GitHub 'issue'). */
  readonly name: string;
  /** Depth in the provider's hierarchy if it exposes one (Epic shallower than Task). */
  readonly hierarchyLevel?: number | undefined;
  /**
   * True for the type an item reports when nobody chose one. GitHub has exactly this: an org can
   * define Task/Bug/Feature and assign them to nothing, leaving every issue reporting 'issue'.
   * A proposal that maps no role onto this type leaves those items with no type role — and so no
   * canonical branch — which is how `task-start` came to refuse every issue in this repository.
   * Providers that require a type on every item (Azure) mark none.
   */
  readonly isDefault?: boolean | undefined;
}

/**
 * A provider's actual configuration as introspected from a live project. `stateKey` is which
 * {@link NativeTarget} key the provider's roles are discriminated on (Azure 'state', GitHub
 * 'label'), carried here so the proposal can build a role map without hardcoding the provider.
 */
export interface ProviderIntrospection {
  readonly provider: string;
  readonly stateKey: string;
  readonly workItemTypes: readonly IntrospectedType[];
  readonly states: readonly IntrospectedState[];
  readonly boardColumns?: readonly string[] | undefined;
  readonly iterations?: readonly string[] | undefined;
}

/**
 * The thin, provider-specific introspection surface an adapter delegates to. Live implementations
 * call the vendor SDK; tests pass an in-memory fixture. Separating it from the proposal logic is
 * what makes `baron init`'s mapping proposal testable without network access.
 */
export interface Introspector {
  introspect(): Promise<ProviderIntrospection>;
}
