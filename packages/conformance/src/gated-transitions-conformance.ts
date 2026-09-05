import {
  BaseIssuesAdapter,
  type CapabilityManifest,
  type IssuesPort,
  type ProviderRoleMap,
  type TransitionField,
  TransitionFieldsRequiredError,
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

/**
 * The screen closing carries: Jira's classic "Resolve" transition, which will not complete without
 * a resolution, and offers a version it does not insist on.
 */
const RESOLUTION = 'resolution';
const FIX_VERSION = 'fixVersion';
const SCREENS: Record<string, readonly TransitionField[]> = {
  [DONE]: [
    { name: RESOLUTION, required: true, allowedValues: ['Fixed', "Won't Do"] },
    { name: FIX_VERSION, required: false },
  ],
};

function adapter(gated: boolean, screens = false): IssuesPort {
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
      ...(screens ? { screenFor: SCREENS } : {}),
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

  describe('a provider whose transitions carry a screen', () => {
    it('refuses before writing, and names every required field with its accepted values', async () => {
      // The refusal has to come from the core's check, not from the provider's rejection: the
      // provider's would arrive after an attempted write, and would name one field at a time.
      const port = adapter(true, true);
      const created = await port.create({ title: 'x', typeRole: 'task' });
      await port.transition(created.id, 'in_progress');
      const attempt = port.transition(created.id, 'done');
      await expect(attempt).rejects.toBeInstanceOf(TransitionFieldsRequiredError);
      await expect(attempt).rejects.toMatchObject({
        code: 'TRANSITION_FIELDS_REQUIRED',
        fields: [{ name: RESOLUTION, required: true, allowedValues: ['Fixed', "Won't Do"] }],
      });
      await expect(attempt).rejects.toThrow(/'resolution' \(one of: Fixed, Won't Do\)/);
      // Nothing moved.
      expect((await port.get(created.id)).role).toBe('in_progress');
    });

    it('does not demand an optional field', async () => {
      const port = adapter(true, true);
      const created = await port.create({ title: 'x', typeRole: 'task' });
      await port.transition(created.id, 'in_progress');
      const moved = await port.transition(created.id, 'done', {
        fields: { [RESOLUTION]: 'Fixed' },
      });
      expect(moved.role).toBe('done');
    });

    it('hands the supplied fields to the provider untouched', async () => {
      // The core checks presence and nothing else. A value the provider would reject is the
      // provider's to reject — the memory fake only enforces presence, so a shape the core might
      // have been tempted to "normalise" arrives exactly as given.
      const port = adapter(true, true);
      const created = await port.create({ title: 'x', typeRole: 'task' });
      await port.transition(created.id, 'in_progress');
      const moved = await port.transition(created.id, 'done', {
        fields: { [RESOLUTION]: { name: 'Fixed' }, [FIX_VERSION]: ['1.2.0'] },
      });
      expect(moved.role).toBe('done');
    });

    it('passes fields through on a provider that asks for none, and lets it decide', async () => {
      // `transitionFields` is optional; the core must not refuse a caller who passed fields to a
      // transport without one — a recipe written for Jira should not break on GitHub. What the
      // provider then does with them is its own: this fake ignores them, Jira rejects a field its
      // screen does not carry, and both are correct.
      const port = adapter(true);
      const created = await port.create({ title: 'x', typeRole: 'task' });
      const moved = await port.transition(created.id, 'in_progress', {
        fields: { [RESOLUTION]: 'Fixed' },
      });
      expect(moved.role).toBe('in_progress');
    });
  });
}
