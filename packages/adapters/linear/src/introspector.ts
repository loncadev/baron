import type { Introspector, ProviderIntrospection, StateCategory } from '@lonca/baron-core';
import { BaronError } from '@lonca/baron-core';
import { LINEAR_PROVIDER, LINEAR_STATE_KEY } from './provider.js';

export interface LinearIntrospectorOptions {
  readonly apiKey: string;
  readonly endpoint?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

/**
 * Linear's `WorkflowState.type` mapped onto Baron's own categories.
 *
 * A map rather than a pass-through, and never a fallback to the raw value: `type` is a plain
 * `String` in Linear's schema, not an enum, and the live API returns values no published list
 * contains (`duplicate` among them). Anything unrecognised becomes `unknown`, which the proposal
 * leaves unmapped and a human then confirms — the honest outcome for a vocabulary that is open.
 */
const CATEGORY: Readonly<Record<string, StateCategory>> = {
  triage: 'proposed',
  backlog: 'proposed',
  unstarted: 'proposed',
  started: 'in_progress',
  completed: 'completed',
  canceled: 'removed',
  duplicate: 'removed',
};

/**
 * Discover the workspace's teams and the states each one owns.
 *
 * Every state is reported with the team that owns it as its `scope` and its id as its `value`. Both
 * matter: `WorkflowState.team` is non-null, so two teams hold different states for the same role,
 * and their names collide — "In Progress" exists in both and identifies neither on its own.
 */
export function createLinearIntrospector(opts: LinearIntrospectorOptions): Introspector {
  const endpoint = opts.endpoint ?? 'https://api.linear.app/graphql';
  const doFetch = opts.fetchImpl ?? fetch;

  return {
    async introspect(): Promise<ProviderIntrospection> {
      const response = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: opts.apiKey },
        body: JSON.stringify({
          query:
            '{ teams { nodes { key name states { nodes { id name type position } } } } cycles { nodes { name number } } }',
        }),
      });
      const payload = (await response.json()) as {
        data?: {
          teams: {
            nodes: Array<{
              key: string;
              states: {
                nodes: Array<{ id: string; name: string; type: string; position: number }>;
              };
            }>;
          };
          cycles: { nodes: Array<{ name?: string | null; number: number }> };
        };
        errors?: Array<{ message: string }>;
      };
      if (payload.errors?.length) {
        throw new BaronError(
          `Linear introspection: ${payload.errors.map((e) => e.message).join('; ')}`,
          'LINEAR_API',
        );
      }
      if (payload.data === undefined) {
        throw new BaronError('Linear introspection returned no data.', 'LINEAR_API');
      }

      const states = payload.data.teams.nodes.flatMap((team) =>
        [...team.states.nodes]
          .sort((a, b) => a.position - b.position)
          .map((state) => ({
            name: state.name,
            category: CATEGORY[state.type] ?? ('unknown' as StateCategory),
            value: state.id,
            scope: team.key,
          })),
      );
      if (states.length === 0) {
        throw new BaronError(
          'Linear introspection found no teams. The API key must be able to see at least one.',
          'LINEAR_API',
        );
      }

      return {
        provider: LINEAR_PROVIDER,
        stateKey: LINEAR_STATE_KEY,
        // Linear has no work-item types. Reporting the one kind it models keeps the type proposal
        // honest — it collapses every type role onto it, and the role rides a label.
        workItemTypes: [{ name: 'Issue' }],
        states,
        iterations: payload.data.cycles.nodes.map((c) => c.name ?? `Cycle ${c.number}`),
      };
    },
  };
}
