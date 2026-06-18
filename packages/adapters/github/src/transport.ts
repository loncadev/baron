import { BaronError, type IssuesTransport } from '@baron/core';

export interface GithubTransportOptions {
  readonly owner: string;
  readonly repo: string;
  /** Fine-grained PAT or token. Read from env / secret-manager by the caller; never committed. */
  readonly token: string;
}

/**
 * Live transport over the GitHub REST API (`@octokit/rest`). Deferred like the Azure transport:
 * the first slice validates translation/impedance with the in-memory conformance transport.
 */
export function createGithubTransport(_options: GithubTransportOptions): IssuesTransport {
  throw new BaronError(
    'GitHub live transport is not wired yet. The first slice validates the translation layer ' +
      'via the conformance suite (in-memory transport). Live REST wiring is the next step.',
    'NOT_IMPLEMENTED',
  );
}
