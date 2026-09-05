import type {
  IntrospectedState,
  IntrospectedType,
  Introspector,
  ProviderIntrospection,
  StateCategory,
} from '@lonca/baron-core';
import { BaronError } from '@lonca/baron-core';
import { JIRA_PROVIDER, JIRA_STATE_KEY } from './provider.js';

export interface JiraIntrospectorOptions {
  readonly site: string;
  readonly email: string;
  readonly apiToken: string;
  readonly project: string;
  readonly fetchImpl?: typeof fetch | undefined;
}

/**
 * Jira's `statusCategory.key` mapped onto Baron's own categories.
 *
 * Jira has exactly three — every status is To Do, In Progress or Done — so `ready`, `in_review` and
 * a blocked state can never be told apart by category alone. That is precisely why the proposal
 * also matches on NAME ("Review", "QA", "Test") and why a human confirms the map: on Jira the
 * category is a hint about which end of the board a status sits on, not an identity.
 */
const CATEGORY: Readonly<Record<string, StateCategory>> = {
  new: 'proposed',
  indeterminate: 'in_progress',
  done: 'completed',
};

/** Jira's three categories in workflow order; anything uncategorised sorts last. */
const CATEGORY_ORDER: Readonly<Record<string, number>> = { new: 0, indeterminate: 1, done: 2 };

interface ProjectStatuses {
  id: string;
  name: string;
  subtask: boolean;
  statuses: Array<{ id: string; name: string; statusCategory?: { key?: string } }>;
}

/**
 * Discover the project's issue types and the statuses each one's workflow can hold.
 *
 * One call answers both: `GET /project/{key}/statuses` lists every issue type with the statuses its
 * workflow reaches. Statuses are reported by NAME (the key the role map uses) and de-duplicated
 * across types, so a project where Bug and Story share a workflow does not show "In Progress"
 * twice. Jira lists them in no particular order (a real site answered "In Review, In Progress,
 * Done, To Do"), so they are ordered by category — To Do, In Progress, Done — which is the order a
 * person reads a workflow in and the order the proposal is shown in.
 */
export function createJiraIntrospector(opts: JiraIntrospectorOptions): Introspector {
  const site = opts.site.replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  const authorization = `Basic ${Buffer.from(`${opts.email}:${opts.apiToken}`).toString('base64')}`;

  return {
    async introspect(): Promise<ProviderIntrospection> {
      const response = await doFetch(
        `${site}/rest/api/2/project/${encodeURIComponent(opts.project)}/statuses`,
        { headers: { authorization, accept: 'application/json' } },
      );
      if (!response.ok) {
        throw new BaronError(
          `Jira introspection: HTTP ${response.status} reading project '${opts.project}'. ` +
            'Check the site URL, the project key, and that the token can browse the project.',
          'JIRA_API',
        );
      }
      const types = (await response.json()) as ProjectStatuses[];
      if (types.length === 0) {
        throw new BaronError(
          `Jira introspection: project '${opts.project}' reports no issue types.`,
          'JIRA_API',
        );
      }

      const workItemTypes: IntrospectedType[] = types.map((type) => ({
        name: type.name,
        // Two levels are all the REST payload states: sub-tasks sit under everything else. Epic
        // sits above Story in Jira's own hierarchy, but that fact lives in the (Premium-only)
        // issue-type hierarchy API, so it is left to the proposal's name heuristics.
        hierarchyLevel: type.subtask ? 1 : 0,
      }));

      const seen = new Map<string, number>();
      const states: IntrospectedState[] = [];
      for (const type of types) {
        for (const status of type.statuses) {
          if (seen.has(status.name)) continue;
          const key = status.statusCategory?.key ?? '';
          seen.set(status.name, CATEGORY_ORDER[key] ?? 3);
          states.push({ name: status.name, category: CATEGORY[key] ?? 'unknown' });
        }
      }
      // Stable, so two statuses of one category keep the order Jira gave them.
      states.sort((a, b) => (seen.get(a.name) ?? 3) - (seen.get(b.name) ?? 3));

      return { provider: JIRA_PROVIDER, stateKey: JIRA_STATE_KEY, workItemTypes, states };
    },
  };
}
