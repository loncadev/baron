import type { Introspector, ProviderIntrospection } from '@lonca/baron-core';
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
      // 'issue' is not a fallback that richer types replace — it is the type of every issue with no
      // Issue Type set, which stays possible even where the feature is enabled. Dropping it once
      // `GET /issue-types` answers is what broke this repo: the org had Task/Bug/Feature defined but
      // assigned to none of its 12 issues, so `baron init` proposed a map in which nothing an issue
      // actually reports could be found, and every task-start failed on a missing branch name.
      const workItemTypes: { name: string; isDefault?: boolean }[] = [
        { name: 'issue', isDefault: true },
      ];
      try {
        // issue-types is a newer, optional route; call it loosely so an absent feature just falls
        // back rather than failing introspection.
        const request = octokit.request as unknown as (
          route: string,
          params: Record<string, unknown>,
        ) => Promise<{ data: unknown }>;
        const { data } = await request('GET /repos/{owner}/{repo}/issue-types', { owner, repo });
        if (Array.isArray(data)) {
          for (const entry of data) {
            const name = String((entry as { name?: string }).name ?? '');
            if (name.length > 0 && !workItemTypes.some((t) => t.name === name)) {
              workItemTypes.push({ name });
            }
          }
        }
      } catch {
        // Issue Types disabled / not available -> 'issue' alone still describes this repo.
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
