/**
 * The Linear provider id, in its own leaf module (no imports) so the transport can read it without
 * importing `index.ts` — which re-exports the transport, and would deadlock at module-evaluation
 * time under real ESM ordering.
 */
export const LINEAR_PROVIDER = 'linear';

/**
 * The NativeTarget key Linear roles are keyed by.
 *
 * A state ID rather than a name, and that is not a preference: `WorkflowState.team` is non-null, so
 * two teams hold different states for the same role, and names collide across them ("In Progress"
 * exists in both and means a different row in each). The id is the only value that identifies one.
 */
export const LINEAR_STATE_KEY = 'stateId';
