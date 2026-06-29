import type { Introspector, ProviderIntrospection } from '@baron/core';
import { Octokit } from 'octokit';
import { GITHUB_PROVIDER } from './provider.js';
import type { GithubTransportOptions } from './transport.js';

/**
 * Live introspection over the GitHub REST API. GitHub's issue vocabulary is mostly fixed: states
 * are binary (open/closed) and workflow nuance rides on labels, so `stateKey` is 'label' and the
 * states are the two intrinsic terminals. Native issue TYPES are an org opt-in feature (often
 * disabled); when present they enrich `workItemTypes`, otherwise it collapses to a single 'issue'.
 * Board columns and iterations live in the separate Projects v2 GraphQL API and are omitted here.
 */
export function createGithubIntrospector(options: GithubTransportOptions): Introspector {
  const { owner, repo, token } = options;
  const octokit = new Octokit({ auth: token });

  return {
    async introspect(): Promise<ProviderIntrospection> {
      let workItemTypes: { name: string }[] = [{ name: 'issue' }];
      try {
        // issue-types is a newer, optional route; call it loosely so an absent feature just falls
        // back rather than failing introspection.
        const request = octokit.request as unknown as (
          route: string,
          params: Record<string, unknown>,
        ) => Promise<{ data: unknown }>;
        const { data } = await request('GET /repos/{owner}/{repo}/issue-types', { owner, repo });
        if (Array.isArray(data) && data.length > 0) {
          workItemTypes = data.map((entry) => ({
            name: String((entry as { name?: string }).name ?? 'issue'),
          }));
        }
      } catch {
        // Issue Types disabled / not available -> keep the single-type fallback.
      }

      return {
        provider: GITHUB_PROVIDER,
        stateKey: 'label',
        workItemTypes,
        states: [
          { name: 'open', category: 'proposed' },
          { name: 'closed', category: 'completed' },
        ],
      };
    },
  };
}
