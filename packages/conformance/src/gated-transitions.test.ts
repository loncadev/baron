import { runGatedTransitionsConformance } from './gated-transitions-conformance.js';

// Exported for any future gated adapter (Jira) to run; this is the reference execution against the
// in-memory transport, so the contract is exercised while no shipped provider gates transitions.
runGatedTransitionsConformance();
