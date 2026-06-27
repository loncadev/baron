import { BaronError, type Introspector } from '@baron/core';
import type { GithubTransportOptions } from './transport.js';

/**
 * Live introspection over the GitHub REST API (issue types, open/closed states, labels). Deferred
 * alongside the live transport: `baron init`'s proposal logic is validated with the in-memory
 * introspector in the conformance suite. This factory keeps the package surface stable.
 */
export function createGithubIntrospector(_options: GithubTransportOptions): Introspector {
  throw new BaronError(
    'GitHub live introspection is not wired yet. The config engine validates its proposal logic ' +
      'via the in-memory introspector (conformance suite). Live REST wiring is the next step.',
    'NOT_IMPLEMENTED',
  );
}
