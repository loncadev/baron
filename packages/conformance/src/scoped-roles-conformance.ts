import {
  BaseIssuesAdapter,
  type CapabilityManifest,
  type IssuesPort,
  type ProviderRoleMap,
} from '@lonca/baron-core';
import { describe, expect, it } from 'vitest';
import { createMemoryTransport } from './memory-transport.js';

/**
 * The contract for a provider whose workflow states are owned by something inside the workspace
 * rather than by the workspace itself.
 *
 * Linear is the case that forces it, and this fixture is its real shape: `WorkflowState.team` is
 * non-null, so two teams hold different state ids for the same role — verified live, where
 * `in_progress` is `fdbc8d47…` in one team and `2e9b8701…` in another even though both are named
 * "In Progress" — and a role can exist in one team and not the other.
 *
 * The suite is deliberately not part of {@link runIssuesConformance}: no shipped adapter is scoped,
 * and making Azure or GitHub answer a question their model does not pose would test the fixture
 * rather than the contract.
 */

/** Two teams, modelled on the verified workspace. Ids shortened; the shape is what matters. */
const KSP = { inProgress: 'ksp-in-progress', done: 'ksp-done', backlog: 'ksp-backlog' };
const BAR = {
  inProgress: 'bar-in-progress',
  inReview: 'bar-code-review',
  done: 'bar-done',
  backlog: 'bar-backlog',
};

const SCOPED_MAP: ProviderRoleMap = {
  stateKey: 'state',
  // Empty on purpose: on a scoped provider the unscoped map belongs to no scope in particular, so
  // there is nothing correct to put here. Anything resolved through it would be some other team's.
  states: {},
  scopes: {
    KSP: {
      backlog: { state: KSP.backlog },
      in_progress: { state: KSP.inProgress },
      done: { state: KSP.done },
    },
    BAR: {
      backlog: { state: BAR.backlog },
      in_progress: { state: BAR.inProgress },
      in_review: { state: BAR.inReview },
      done: { state: BAR.done },
    },
  },
};

const manifest: CapabilityManifest = {
  provider: 'scoped-memory',
  issues: {
    hierarchy: true,
    subIssues: false,
    separateBoardColumn: false,
    sprints: false,
    arbitraryStates: true,
    nativeLabels: true,
    nativeTypes: true,
    typeFiltering: true,
    comments: true,
    issueLinks: true,
    assignment: true,
  },
};

function adapterFor(scope: 'KSP' | 'BAR'): IssuesPort {
  const owned = Object.values(scope === 'KSP' ? KSP : BAR);
  return new BaseIssuesAdapter(
    manifest,
    {
      provider: 'scoped-memory',
      roleMap: SCOPED_MAP,
      typeMap: { task: 'Task', bug: 'Bug', story: 'Story', epic: 'Epic' },
      gapPolicy: {},
    },
    createMemoryTransport({
      stateKey: 'state',
      defaultDiscriminator: scope === 'KSP' ? KSP.backlog : BAR.backlog,
      scope,
      ownedDiscriminators: owned,
    }),
  );
}

export function runScopedRoleMapConformance(): void {
  describe('scoped role map', () => {
    it('writes the scope’s own target, not another scope’s', async () => {
      // The whole contract in one assertion. The transport refuses a discriminator its scope does
      // not own — exactly as Linear refuses one team's state id on another team's issue — so a
      // resolver that ignored scope does not merely return the wrong value here, it throws.
      for (const [scope, expected] of [
        ['KSP', KSP.inProgress],
        ['BAR', BAR.inProgress],
      ] as const) {
        const adapter = adapterFor(scope);
        const created = await adapter.create({ title: 'x', typeRole: 'task' });
        const moved = await adapter.transition(created.id, 'in_progress');
        expect(moved.nativeState, `scope ${scope}`).toBe(expected);
        expect(moved.role, `scope ${scope}`).toBe('in_progress');
      }
    });

    it('reads a role back through the scope that owns the state', async () => {
      const adapter = adapterFor('BAR');
      const created = await adapter.create({ title: 'x', typeRole: 'task' });
      const moved = await adapter.transition(created.id, 'in_review');
      expect(moved.nativeState).toBe(BAR.inReview);
      // The reverse lookup has to use the item's scope too: BAR's review state means nothing in KSP.
      expect((await adapter.get(created.id)).role).toBe('in_review');
    });

    it('refuses a role the scope does not map, naming the scope', async () => {
      // KSP has no review state, so `in_review` is not merely unset — it cannot exist there. The
      // message has to say which scope, because "in_review is unmapped" sends you to the wrong
      // half of the policy.
      const adapter = adapterFor('KSP');
      const created = await adapter.create({ title: 'x', typeRole: 'task' });
      await expect(adapter.transition(created.id, 'in_review')).rejects.toThrow(/KSP/);
    });

    it('finds items across every scope that maps the role', async () => {
      // A role expands to one target per scope. Querying `done` must reach both teams' done states,
      // which is the read-side half of the same defect.
      const ksp = adapterFor('KSP');
      const bar = adapterFor('BAR');
      const a = await ksp.create({ title: 'ksp item', typeRole: 'task' });
      await ksp.transition(a.id, 'done');
      const b = await bar.create({ title: 'bar item', typeRole: 'task' });
      await bar.transition(b.id, 'done');

      // Each adapter holds its own store, so this asserts the expansion reaches its own scope's
      // target rather than resolving to a single global one.
      expect((await ksp.query({ role: 'done' })).map((i) => i.nativeState)).toEqual([KSP.done]);
      expect((await bar.query({ role: 'done' })).map((i) => i.nativeState)).toEqual([BAR.done]);
    });
  });
}
