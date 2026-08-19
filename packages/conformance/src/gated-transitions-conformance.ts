import {
  BaseIssuesAdapter,
  type CapabilityManifest,
  type IssuesPort,
  type ProviderRoleMap,
} from '@lonca/baron-core';
import { describe, expect, it } from 'vitest';
import { createMemoryTransport } from './memory-transport.js';

/**
 * The contract for a provider that decides which moves are legal from where an item currently is.
 *
 * Jira is the case that forces it: there is no "set the status" call. You read the transitions its
 * workflow permits from the issue's present state and perform one of those, so the reachable set is
 * a function of the ITEM — which `applyTarget(id, target)` alone cannot express.
 *
 * What the suite pins down is that the core VERIFIES rather than chooses. Which native target a role
 * means stays settled by the confirmed map; the provider only answers whether it is reachable now.
 * A core that picked from the candidates would silently re-derive the mapping, and the whole premise
 * is that the mapping was confirmed once by a human rather than guessed per call.
 */

const NEW = 'New';
const ACTIVE = 'Active';
const REVIEW = 'In Review';
const DONE = 'Done';

/** A workflow that will not let an item jump straight from New to Done. */
const WORKFLOW: Record<string, readonly string[]> = {
  [NEW]: [ACTIVE],
  [ACTIVE]: [REVIEW, DONE],
  [REVIEW]: [ACTIVE, DONE],
  [DONE]: [ACTIVE],
};

const ROLE_MAP: ProviderRoleMap = {
  stateKey: 'state',
  states: {
    backlog: { state: NEW },
    in_progress: { state: ACTIVE },
    in_review: { state: REVIEW },
    done: { state: DONE },
  },
};

const manifest: CapabilityManifest = {
  provider: 'gated-memory',
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

function adapter(gated: boolean): IssuesPort {
  return new BaseIssuesAdapter(
    manifest,
    {
      provider: 'gated-memory',
      roleMap: ROLE_MAP,
      typeMap: { task: 'Task', bug: 'Bug', story: 'Story', epic: 'Epic' },
      gapPolicy: {},
    },
    createMemoryTransport({
      stateKey: 'state',
      defaultDiscriminator: NEW,
      ...(gated ? { reachableFrom: WORKFLOW } : {}),
    }),
  );
}

export function runGatedTransitionsConformance(): void {
  describe('a provider that gates which transitions are legal', () => {
    it('refuses a move the provider will not make, and names what it would', async () => {
      // New -> Done is not in the workflow. The refusal has to carry the permitted set: "refused"
      // on its own leaves the caller with nothing to try next, which is how an agent starts guessing.
      const port = adapter(true);
      const created = await port.create({ title: 'x', typeRole: 'task' });
      await expect(port.transition(created.id, 'done')).rejects.toThrow(/permits: Active/);
    });

    it('allows a move the provider permits', async () => {
      const port = adapter(true);
      const created = await port.create({ title: 'x', typeRole: 'task' });
      const moved = await port.transition(created.id, 'in_progress');
      expect(moved.role).toBe('in_progress');
      // And the next hop, now legal from where it landed.
      expect((await port.transition(created.id, 'done')).role).toBe('done');
    });

    it('verifies rather than chooses: an unmapped role stays unmapped even when reachable', async () => {
      // `ready` is absent from the map, and no amount of the provider offering states can supply it.
      // A core that picked a target from the candidates would invent a mapping nobody confirmed.
      const port = adapter(true);
      const created = await port.create({ title: 'x', typeRole: 'task' });
      await expect(port.transition(created.id, 'ready')).rejects.toThrow(/no native mapping/);
    });

    it('leaves a provider that gates nothing exactly as it was', async () => {
      // The other half of the contract: `availableTargets` is optional, and a transport without one
      // must behave identically — including the jump this workflow would have refused.
      const port = adapter(false);
      const created = await port.create({ title: 'x', typeRole: 'task' });
      expect((await port.transition(created.id, 'done')).role).toBe('done');
    });
  });
}
