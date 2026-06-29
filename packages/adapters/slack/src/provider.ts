/**
 * The Slack provider id. Kept in its own leaf module (no imports) so the transport module can read it
 * WITHOUT importing `index.ts` — `index.ts` re-exports the transport, so referencing an `index.ts`
 * const at the transport's module top-level would hit a circular temporal-dead-zone error under real
 * ESM evaluation order (the same fix the other adapters use).
 */
export const SLACK_PROVIDER = 'slack';
