import { runScopedRoleMapConformance } from './scoped-roles-conformance.js';

// The suite is exported for any future scoped adapter to run; this is the reference execution,
// against the in-memory transport, so the contract is exercised even while no shipped provider
// scopes its states.
runScopedRoleMapConformance();
