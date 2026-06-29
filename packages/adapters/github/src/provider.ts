/**
 * The GitHub provider id. Kept in its own leaf module (no imports) so the transport, introspector,
 * and scm modules can read it WITHOUT importing `index.ts` — `index.ts` re-exports those modules, so
 * referencing an `index.ts` const at their module top-level would hit a circular temporal-dead-zone
 * error under real ESM evaluation order.
 */
export const GITHUB_PROVIDER = 'github';
