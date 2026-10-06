import { runBoardColumnConformance } from './board-column-conformance.js';

// The reference execution against the in-memory transport; Azure's own conformance run adds the
// live transport's half through its unit tests, which stub the Work API.
runBoardColumnConformance();
