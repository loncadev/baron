import { proposeRoleMap } from '@lonca/baron-core';
import { describe, expect, it } from 'vitest';
import { createLinearIntrospector, linearManifest } from './index.js';

const apiKey = process.env.LINEAR_API_KEY;
const live = Boolean(apiKey);

/**
 * Gated live check that introspection sees what the schema promises.
 *
 * The offline proposal test feeds a fixture shaped like Linear. This asserts the fixture is honest:
 * that a real workspace reports states per team, with ids, and that the proposal built from it is
 * scoped. It reads only — it creates nothing.
 */
describe.skipIf(!live)('linear live introspection', () => {
  it('reports every team’s states with an id and a scope, and proposes a scoped map', async () => {
    const introspection = await createLinearIntrospector({ apiKey: apiKey as string }).introspect();

    expect(introspection.stateKey).toBe('stateId');
    expect(introspection.states.length).toBeGreaterThan(0);
    // Every state must carry both, or the proposal cannot key on identity or group by owner.
    for (const state of introspection.states) {
      expect(state.value, `state '${state.name}' has no id`).toBeTruthy();
      expect(state.scope, `state '${state.name}' has no team`).toBeTruthy();
    }

    const scopes = new Set(introspection.states.map((s) => s.scope));
    expect(scopes.size, 'need at least two teams to prove scoping is real').toBeGreaterThan(1);

    const { entry } = proposeRoleMap(introspection, linearManifest);
    expect(entry.scopes).toBeDefined();
    expect(Object.keys(entry.scopes ?? {}).length).toBe(scopes.size);
    expect(entry.states, 'the flat map belongs to no team on a scoped provider').toEqual({});

    // The claim this whole contract rests on: the same role, a different id per team.
    const inProgress = Object.values(entry.scopes ?? {})
      .map((states) => states.in_progress?.stateId)
      .filter(Boolean);
    expect(new Set(inProgress).size, 'in_progress resolved to the same id in two teams').toBe(
      inProgress.length,
    );
  }, 60_000);
});
