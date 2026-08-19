import type { ProviderRoleMap } from '@lonca/baron-core';
import { describe, expect, it } from 'vitest';
import {
  LINEAR_STATE_KEY,
  createLinearTransport,
  defineLinearIssuesAdapter,
  exampleLinearTypeMap,
} from './index.js';

const apiKey = process.env.LINEAR_API_KEY;
const team = process.env.LINEAR_TEAM;
const live = Boolean(apiKey && team);

/**
 * Gated live smoke test: skipped unless LINEAR_API_KEY and LINEAR_TEAM are in the environment.
 *
 * The conformance suite proves the translation layer network-free. It cannot prove the live wiring,
 * and it cannot check the manifest, which is a set of claims about a real API. This asserts the four
 * things only a real call can settle — that the team comes back as the scope, that a transition
 * writes a state id belonging to THAT team, that a label name resolves to an id and is created when
 * missing, and that a plural target filter reaches the provider rather than being ignored.
 *
 * It CREATES an issue. Point LINEAR_TEAM at a throwaway team, never one holding real work.
 */
describe.skipIf(!live)('linear live smoke', () => {
  const gql = async (query: string, variables?: Record<string, unknown>) => {
    const response = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: apiKey as string },
      body: JSON.stringify({ query, ...(variables !== undefined ? { variables } : {}) }),
    });
    const payload = (await response.json()) as {
      data?: Record<string, unknown>;
      errors?: Array<{ message: string }>;
    };
    if (payload.errors) throw new Error(payload.errors.map((e) => e.message).join('; '));
    return payload.data as Record<string, never>;
  };

  /**
   * Build the role map from the team's OWN states rather than hardcoding ids.
   *
   * Hardcoded ids would tie a committed test to one workspace, and discovering them is what
   * `baron init` will have to do for a scoped provider anyway — so this doubles as a check that the
   * discovery is possible at all.
   */
  const discoverRoleMap = async (): Promise<ProviderRoleMap> => {
    const data = (await gql(
      'query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { key states { nodes { id name type } } } } }',
      { key: team },
    )) as unknown as {
      teams: {
        nodes: Array<{
          key: string;
          states: { nodes: Array<{ id: string; name: string; type: string }> };
        }>;
      };
    };
    const found = data.teams.nodes[0];
    expect(found, `team '${team}' not found in this workspace`).toBeDefined();
    const byType = (type: string) => found?.states.nodes.find((s) => s.type === type)?.id;
    const scope: Record<string, { [k: string]: string }> = {};
    // `type` is only a hint for FINDING candidates here — never for deciding a role at runtime. It
    // is a plain String in the schema and the live API returns values (`duplicate`) that no
    // published list contains, which is exactly why the map is confirmed rather than derived.
    for (const [role, type] of [
      ['backlog', 'backlog'],
      ['ready', 'unstarted'],
      ['in_progress', 'started'],
      ['done', 'completed'],
    ] as const) {
      const id = byType(type);
      if (id !== undefined) scope[role] = { [LINEAR_STATE_KEY]: id };
    }
    return { stateKey: LINEAR_STATE_KEY, states: {}, scopes: { [team as string]: scope } };
  };

  it('reports the team as the scope, and transitions within it', async () => {
    const roleMap = await discoverRoleMap();
    const adapter = defineLinearIssuesAdapter(
      { roleMap, typeMap: exampleLinearTypeMap, gapPolicy: {} },
      createLinearTransport({ apiKey: apiKey as string, team: team as string }),
    );

    const created = await adapter.create({
      title: `baron smoke ${new Date().toISOString()}`,
      typeRole: 'task',
    });
    // The scope is the whole reason this adapter exists: without it the core resolves roles against
    // a map belonging to no team.
    expect(created.provider).toBe('linear');
    expect(
      created.key.startsWith(`${team}-`),
      `key '${created.key}' should carry the team prefix`,
    ).toBe(true);
    // The branch must carry the human reference, not the UUID: a Linear id is 36 characters and
    // would otherwise land in every branch, PR title and checkout.
    expect(created.branchName, 'the branch name should not contain the UUID').not.toContain(
      created.id,
    );
    expect(created.branchName).toContain(created.key.toLowerCase());

    const moved = await adapter.transition(created.id, 'in_progress');
    expect(moved.role).toBe('in_progress');
    // The state written must be one of THIS team's — Linear refuses another team's id, so a pass
    // here is the provider itself confirming the scope was resolved correctly.
    const expected = roleMap.scopes?.[team as string]?.in_progress?.[LINEAR_STATE_KEY];
    expect(moved.nativeState).toBe(expected);

    // Reading it back has to resolve the role through the same scope.
    expect((await adapter.get(created.id)).role).toBe('in_progress');
  }, 60_000);

  it('resolves a label name to an id, creating it when absent', async () => {
    // Baron's contract passes label NAMES; Linear's mutation takes ids. This is the adapter's own
    // translation, and nothing network-free can prove the creation half of it.
    const roleMap = await discoverRoleMap();
    const adapter = defineLinearIssuesAdapter(
      { roleMap, typeMap: exampleLinearTypeMap, gapPolicy: {} },
      createLinearTransport({ apiKey: apiKey as string, team: team as string }),
    );
    const created = await adapter.create({
      title: `baron smoke labels ${Date.now()}`,
      typeRole: 'bug',
      labels: ['baron-smoke'],
    });
    expect(created.labels).toContain('baron-smoke');
    // A bug's type role rides a label on Linear, which has no work-item types at all.
    expect(created.typeRole).toBe('bug');
  }, 60_000);

  it('reports the team’s own states as reachable, catching a foreign state before the write', async () => {
    // Linear gates nothing, so this is an identity check rather than a workflow one: a map pointing
    // at another team's state id is a real mistake, and answering with THIS team's states turns the
    // provider's eventual rejection into a refusal that names what is actually available.
    const roleMap = await discoverRoleMap();
    const transport = createLinearTransport({ apiKey: apiKey as string, team: team as string });
    const adapter = defineLinearIssuesAdapter(
      { roleMap, typeMap: exampleLinearTypeMap, gapPolicy: {} },
      transport,
    );
    const created = await adapter.create({
      title: `baron smoke reach ${Date.now()}`,
      typeRole: 'task',
    });

    const reachable = await transport.availableTargets?.(created.id);
    expect(reachable?.length, 'the team must own at least one state').toBeGreaterThan(0);
    // Every mapped role for this team has to be among them, or the map and the workspace disagree.
    for (const target of Object.values(roleMap.scopes?.[team as string] ?? {})) {
      const wanted = target?.[LINEAR_STATE_KEY];
      expect(
        reachable?.some((r) => r[LINEAR_STATE_KEY] === wanted),
        `mapped state '${wanted}' is not one this team owns`,
      ).toBe(true);
    }
  }, 60_000);

  it('filters server-side by a set of state ids, not by pulling everything back', async () => {
    // The plural `targets` contract exists because a role expands per scope. Linear's own filter
    // takes a set (`state: { id: { in: [...] } }`), so this proves the two shapes actually meet —
    // a transport that ignored the filter would return items in other states too.
    const roleMap = await discoverRoleMap();
    const adapter = defineLinearIssuesAdapter(
      { roleMap, typeMap: exampleLinearTypeMap, gapPolicy: {} },
      createLinearTransport({ apiKey: apiKey as string, team: team as string }),
    );
    const wanted = roleMap.scopes?.[team as string]?.in_progress?.[LINEAR_STATE_KEY];
    const found = await adapter.query({ role: 'in_progress', limit: 25 });
    for (const issue of found) {
      expect(issue.nativeState, `'${issue.key}' came back from an in_progress filter`).toBe(wanted);
    }
  }, 60_000);
});
