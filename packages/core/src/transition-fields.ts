/**
 * A field a transition demands before the provider will perform it.
 *
 * Jira is why this exists: a workflow transition can carry a screen, and the screen can require
 * fields (`resolution`, `fixVersions`) that have nothing to do with the role being asked for. The
 * transport REPORTS these — name, whether it is required, and any closed set of values — and the
 * core decides whether the caller supplied enough to proceed. The core never interprets a field:
 * what `resolution` means is the provider's business (invariant 4).
 */
export interface TransitionField {
  /** Provider-native field name, exactly as the transport expects it back in `fields`. */
  readonly name: string;
  /** When true the provider refuses the transition without it; when false it is merely accepted. */
  readonly required: boolean;
  /** A closed set of accepted values, when the provider publishes one (a Jira `allowedValues`). */
  readonly allowedValues?: readonly string[] | undefined;
}

/**
 * Values a caller supplies for the fields a transition demands, keyed by the provider-native name
 * the transport reported. `unknown` on purpose: the core passes these through untouched, and a
 * provider may want a string, a number, a list, or an object (`{ name: 'Fixed' }`). They must be
 * JSON-serialisable, because every route into the core — MCP arguments, recipe `with` blocks — is.
 */
export type TransitionFields = Readonly<Record<string, unknown>>;

/** Options a caller may attach to a transition. */
export interface TransitionOptions {
  readonly fields?: TransitionFields | undefined;
}
