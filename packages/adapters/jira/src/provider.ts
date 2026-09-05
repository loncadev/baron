/**
 * The Jira provider id, in its own leaf module (no imports) so the transport can read it without
 * importing `index.ts` — which re-exports the transport, and would deadlock at module-evaluation
 * time under real ESM ordering.
 */
export const JIRA_PROVIDER = 'jira';

/**
 * The NativeTarget key Jira roles are keyed by: the status NAME.
 *
 * A name rather than an id, and that is a choice worth stating. Jira statuses do carry ids, but a
 * project's workflow never holds two statuses with one name, transitions report their destination
 * by name, and a `policy.json` a human confirms should read `"In Review"` rather than `"10023"`.
 * The cost is that renaming a status in Jira's admin invalidates the map — the same trade Azure
 * makes, and `baron doctor` is what catches it.
 */
export const JIRA_STATE_KEY = 'status';
