import {
  ASSIGNEE_ME,
  BRANCH_TYPE_PREFIXES,
  CapabilityGapError,
  type GapPolicy,
  ITERATION_CURRENT,
  type IssuesPort,
  type RecordingLogger,
  RoleMappingError,
  type TypeMap,
  type WorkflowRole,
} from '@lonca/baron-core';
import { describe, expect, it } from 'vitest';

export interface IssuesConformanceTarget {
  readonly label: string;
  /**
   * Build a fresh adapter (in-memory transport) with the given gap policy, plus its logger. The
   * optional type map overrides the target's default — the contract has to hold for any valid map,
   * and a map that collapses every role onto one native type hides half of it.
   */
  build(
    gapPolicy: GapPolicy,
    typeMap?: TypeMap,
    /** Transport fidelity overrides, for asserting what happens when a provider cannot do a thing. */
    transport?: { readonly canRemoveLabels?: boolean },
  ): { adapter: IssuesPort; logger: RecordingLogger };
  /**
   * A type map in which `bug` and `task` each name a native type no other role uses. Not every
   * provider can make all six distinct (Azure has no Sub-task type, so subtask shares Task), so the
   * contract is stated over the two roles the suite asserts on.
   *
   * This shape exposed a real bug: the `type:<role>` label was written only when the map collapsed,
   * so the moment an install described its provider's actual types, every created item lost the one
   * thing carrying its role.
   */
  readonly distinctTypeMap: TypeMap;
  /** A mid-workflow role that IS mapped for this provider (e.g. 'in_review'). */
  readonly mappedMidRole: WorkflowRole;
  /** The terminal role (e.g. 'done'). */
  readonly mappedDoneRole: WorkflowRole;
  /** A role deliberately left out of the role map (e.g. 'ready'). */
  readonly unmappedRole: WorkflowRole;
}

const emulateStates: GapPolicy = { arbitraryStates: { kind: 'emulate', strategy: 'labels' } };

/**
 * A provider that filters by type server-side ignores this; one that cannot needs it, and every gap
 * policy is per-install anyway — the suite states the behavior it is asserting rather than relying
 * on the adapter's recommended default.
 */
const emulateTypeFiltering: GapPolicy = {
  typeFiltering: { kind: 'emulate', strategy: 'post-filter' },
};

/**
 * The contract every `issues` adapter must satisfy. It asserts provider-agnostic behavior while
 * branching on the adapter's own manifest, so the same suite proves correct-but-different handling
 * for a rich provider (Azure) and a flat one (GitHub).
 */
export function runIssuesConformance(target: IssuesConformanceTarget): void {
  describe(`issues conformance: ${target.label}`, () => {
    it('create returns a normalized issue', async () => {
      const { adapter } = target.build({});
      const issue = await adapter.create({
        title: 'Hello',
        typeRole: 'task',
        labels: ['conformance-label'],
      });
      expect(issue.provider).toBe(adapter.manifest.provider);
      expect(issue.key).toBeTruthy();
      expect(issue.title).toBe('Hello');
      expect(issue.nativeType).toBeTruthy();
      // A provider with native labels must persist labels supplied at creation (a transport that
      // drops them is a silent capability gap — invariant #5).
      if (adapter.manifest.issues.nativeLabels) {
        expect(issue.labels).toContain('conformance-label');
      }
      expect(issue.typeRole).toBeDefined();
    });

    it('the requested type role round-trips through create + get', async () => {
      // A provider whose native types are flat (GitHub: everything is an `issue`) cannot recover the
      // role from the native type — the reverse lookup tie-breaks to story, so a bug used to read
      // back as a story (and got a feature/ branch prefix). The role now rides a `type:<role>` label
      // there, exactly as hierarchy rides `parent:<id>`. Either way, what you asked for is what you get.
      const { adapter } = target.build({});
      for (const typeRole of ['bug', 'task'] as const) {
        const created = await adapter.create({ title: `a ${typeRole}`, typeRole });
        expect(created.typeRole).toBe(typeRole);
        expect((await adapter.get(created.id)).typeRole).toBe(typeRole);
      }
    });

    // The whole point of taking blocked out of WORKFLOW_ROLES: as a role it OVERWROTE the role it was
    // blocking, so nothing recorded whether the item had been in_progress or in_review, and
    // unblocking had nowhere to return to.
    it('blocking leaves the workflow role exactly where it was', async () => {
      const { adapter } = target.build(emulateStates);
      const issue = await adapter.create({ title: 'stuck', typeRole: 'task' });
      const working = await adapter.transition(issue.id, target.mappedMidRole);
      expect(working.blocked).toBe(false);

      const blocked = await adapter.block(issue.id, 'waiting on the vendor');
      expect(blocked.blocked).toBe(true);
      expect(blocked.role, 'blocking must not move the item').toBe(working.role);
      expect((await adapter.get(issue.id)).role).toBe(working.role);

      const unblocked = await adapter.unblock(issue.id);
      expect(unblocked.blocked).toBe(false);
      expect(unblocked.role, 'unblocking must return it to where the work was').toBe(working.role);
    });

    // `removeLabel` is optional on the transport contract, so a provider can implement `addLabel`
    // and not its inverse — which turns the blocked flag into a one-way door. It must say so rather
    // than appear to work: an item that cannot be unblocked through Baron is worse than one that
    // could never be blocked.
    it('refuses to unblock rather than pretend, when the transport cannot clear a label', async () => {
      const { adapter } = target.build({}, undefined, { canRemoveLabels: false });
      const issue = await adapter.create({ title: 'stuck', typeRole: 'task' });
      await adapter.block(issue.id, 'waiting');
      await expect(adapter.unblock(issue.id)).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    });

    it('refuses to block without a reason', async () => {
      const { adapter } = target.build({});
      const issue = await adapter.create({ title: 'stuck', typeRole: 'task' });
      await expect(adapter.block(issue.id, '   ')).rejects.toMatchObject({
        code: 'BLOCK_REASON_REQUIRED',
      });
    });

    it('blocking and unblocking are idempotent', async () => {
      const { adapter } = target.build({});
      const issue = await adapter.create({ title: 'stuck', typeRole: 'task' });
      await adapter.block(issue.id, 'once');
      const twice = await adapter.block(issue.id, 'again');
      expect(twice.blocked).toBe(true);
      await adapter.unblock(issue.id);
      expect((await adapter.unblock(issue.id)).blocked).toBe(false);
    });

    // With no policy for it, a provider that cannot filter by type must REFUSE rather than hand back
    // an unfiltered result. Strict-by-default is what turns this from a wrong answer into a question.
    it('refuses a type-role query it cannot honor when no gap policy allows it', async () => {
      const { adapter } = target.build({});
      if (adapter.manifest.issues.typeFiltering) return;
      await adapter.create({ title: 'a task', typeRole: 'task' });
      await expect(adapter.query({ typeRole: 'task' })).rejects.toBeInstanceOf(CapabilityGapError);
    });

    // A provider that cannot filter by type server-side IGNORES the filter and returns everything,
    // which reads as a successful filter — the worst of both outcomes, and a silent gap by any
    // reading of invariant #5. Whether the filter happens in the provider or in the port, what comes
    // back must be what was asked for.
    it('a query filtered by type role returns only that type role', async () => {
      const { adapter } = target.build(emulateTypeFiltering, target.distinctTypeMap);
      await adapter.create({ title: 'a bug', typeRole: 'bug' });
      await adapter.create({ title: 'a task', typeRole: 'task' });
      await adapter.create({ title: 'another task', typeRole: 'task' });

      const bugs = await adapter.query({ typeRole: 'bug' });
      expect(bugs.length).toBe(1);
      expect(bugs.every((i) => i.typeRole === 'bug')).toBe(true);

      const tasks = await adapter.query({ typeRole: 'task' });
      expect(tasks.length).toBe(2);
      expect(tasks.every((i) => i.typeRole === 'task')).toBe(true);
    });

    // `limit` has to survive the emulation. Handing it to a transport that cannot filter would make
    // it a budget over the WRONG set: N items of every type, then cut down to fewer than N.
    it('honors limit alongside a type-role filter', async () => {
      const { adapter } = target.build(emulateTypeFiltering, target.distinctTypeMap);
      await adapter.create({ title: 'noise', typeRole: 'bug' });
      for (let i = 0; i < 3; i += 1) await adapter.create({ title: `task ${i}`, typeRole: 'task' });

      const some = await adapter.query({ typeRole: 'task', limit: 2 });
      expect(some.length).toBe(2);
      expect(some.every((i) => i.typeRole === 'task')).toBe(true);
    });

    // The same contract under a type map that does NOT collapse. It has to be stated separately,
    // because the collapsing map above makes the label unconditional and so proves nothing about
    // the gate: an install that described its provider's real types lost the label on every item,
    // and every bug started branching feature/ again. The map is install config — the round-trip
    // must not depend on which one an install happens to write.
    it('the type role round-trips under a type map that does not collapse it', async () => {
      const { adapter } = target.build({}, target.distinctTypeMap);
      for (const typeRole of ['bug', 'task'] as const) {
        const created = await adapter.create({ title: `a ${typeRole}`, typeRole });
        expect(created.typeRole, `create() lost typeRole '${typeRole}'`).toBe(typeRole);
        expect((await adapter.get(created.id)).typeRole, `get() lost typeRole '${typeRole}'`).toBe(
          typeRole,
        );
      }
    });

    it('create preserves the body for a bug (body must not be dropped for any type role)', async () => {
      // A bug carries repro steps as its body; some providers route that to a type-specific native
      // field (Azure -> ReproSteps). Whatever the routing, the body must survive create for a bug
      // exactly as for a task — a dropped bug body would be a silent gap (invariant #5).
      const { adapter } = target.build({});
      const repro = '1. do X\n2. observe Y\nExpected: Z';
      const bug = await adapter.create({ title: 'boom', typeRole: 'bug', body: repro });
      expect(bug.typeRole).toBeDefined();
      const reloaded = await adapter.get(bug.id);
      expect(reloaded.body).toBe(repro);
    });

    it('ensureLabels provisions idempotently (safe to call repeatedly)', async () => {
      // Provisioning role labels must be safe to run on every init: creating what's missing, a no-op
      // for what exists. A native-state provider (no transport ensureLabels) simply does nothing.
      const { adapter } = target.build({});
      const specs = [
        { name: 'in-progress', color: 'fbca04', description: 'Baron: in progress' },
        { name: 'done', color: '0e8a16', description: 'Baron: done' },
      ];
      await expect(adapter.ensureLabels(specs)).resolves.toBeUndefined();
      await expect(adapter.ensureLabels(specs)).resolves.toBeUndefined(); // idempotent
    });

    it('update patches title/body and leaves omitted fields alone', async () => {
      const { adapter } = target.build({});
      const issue = await adapter.create({
        title: 'typo in titel',
        typeRole: 'task',
        body: 'keep me',
      });

      const retitled = await adapter.update(issue.id, { title: 'typo in title, fixed' });
      expect(retitled.title).toBe('typo in title, fixed');
      // A title-only patch must not wipe the body — this is a patch, not a replace.
      expect((await adapter.get(issue.id)).body).toBe('keep me');

      const rebodied = await adapter.update(issue.id, { body: 'a fuller description' });
      expect((await adapter.get(issue.id)).body).toBe('a fuller description');
      expect(rebodied.title).toBe('typo in title, fixed');
    });

    it("update routes a bug's body the same way create does", async () => {
      // Providers that give bugs their own body field (Azure -> ReproSteps) must route an EDITED body
      // there too; if update wrote to the create-field instead, the repro would read back stale.
      const { adapter } = target.build({});
      const bug = await adapter.create({ title: 'boom', typeRole: 'bug', body: 'first repro' });
      await adapter.update(bug.id, { body: 'corrected repro' });
      expect((await adapter.get(bug.id)).body).toBe('corrected repro');
    });

    it('update with no fields is refused rather than silently doing nothing', async () => {
      const { adapter } = target.build({});
      const issue = await adapter.create({ title: 'x', typeRole: 'task' });
      await expect(adapter.update(issue.id, {})).rejects.toMatchObject({
        code: 'ISSUE_UPDATE_EMPTY',
      });
    });

    it('reconcile never invents a role, and is safe to call on any item', async () => {
      // Widening the port contract, so the suite covers it: reconcile only ever aligns emulation
      // with what the provider already reports, so on a freshly created item it must change
      // nothing — and running it twice must land in the same place.
      const { adapter } = target.build(emulateStates);
      const issue = await adapter.create({ title: 'reconcile me', typeRole: 'task' });

      const once = await adapter.reconcile(issue.id);
      expect(once.id).toBe(issue.id);
      expect(once.role).toBe(issue.role);

      const twice = await adapter.reconcile(issue.id);
      expect(twice.role).toBe(once.role);
      expect([...twice.labels].sort()).toEqual([...once.labels].sort());
    });

    it('transition to a mapped role resolves that role back', async () => {
      const { adapter } = target.build(emulateStates);
      const issue = await adapter.create({ title: 'x', typeRole: 'task' });
      const moved = await adapter.transition(issue.id, target.mappedMidRole);
      expect(moved.role).toBe(target.mappedMidRole);
    });

    it('a COLD read reports the role — not just the value a write echoed back', async () => {
      // A label-keyed provider's plain get carries open/closed as the discriminator, which matches no
      // label, so the role used to come back undefined on every fresh read (task-list showed blanks).
      const { adapter } = target.build(emulateStates);
      const issue = await adapter.create({ title: 'cold read', typeRole: 'task' });
      await adapter.transition(issue.id, target.mappedMidRole);
      expect((await adapter.get(issue.id)).role).toBe(target.mappedMidRole);
    });

    it('a transition leaves exactly ONE role marker — the old one is cleared', async () => {
      // Where roles ride labels the write only ADDS one, so without cleanup an item ends up tagged
      // in-progress AND in-review, and whichever matched first won the reverse lookup.
      const { adapter } = target.build(emulateStates);
      const issue = await adapter.create({ title: 'two moves', typeRole: 'task' });
      await adapter.transition(issue.id, target.mappedMidRole);
      const moved = await adapter.transition(issue.id, target.mappedDoneRole);
      expect(moved.role).toBe(target.mappedDoneRole);
      expect((await adapter.get(issue.id)).role).toBe(target.mappedDoneRole);
    });

    it('transition to the done role resolves to done', async () => {
      const { adapter } = target.build({});
      const issue = await adapter.create({ title: 'x', typeRole: 'task' });
      const done = await adapter.transition(issue.id, target.mappedDoneRole);
      expect(done.role).toBe(target.mappedDoneRole);
    });

    it('transition to an unmapped role throws RoleMappingError', async () => {
      const { adapter } = target.build(emulateStates);
      const issue = await adapter.create({ title: 'x', typeRole: 'task' });
      await expect(adapter.transition(issue.id, target.unmappedRole)).rejects.toBeInstanceOf(
        RoleMappingError,
      );
    });

    describe('hierarchy handling per manifest + policy', () => {
      it('native hierarchy stores the parent; flat providers emulate or error', async () => {
        const probe = target.build({});
        if (probe.adapter.manifest.issues.hierarchy) {
          const child = await probe.adapter.create({
            title: 'child',
            typeRole: 'task',
            parentId: '42',
          });
          expect(child.parentId).toBe('42');
          return;
        }

        // Flat provider, strict policy -> loud failure, never silent.
        await expect(
          probe.adapter.create({ title: 'child', typeRole: 'task', parentId: '42' }),
        ).rejects.toBeInstanceOf(CapabilityGapError);

        // Flat provider, emulate:labels -> parent encoded as a label + a warning is logged.
        const emu = target.build({ hierarchy: { kind: 'emulate', strategy: 'labels' } });
        const child = await emu.adapter.create({
          title: 'child',
          typeRole: 'task',
          parentId: '42',
        });
        expect(child.labels).toContain('parent:42');
        expect(child.parentId).toBeUndefined();
        expect(emu.logger.entries.some((e) => e.level === 'warn')).toBe(true);
      });
    });

    describe('arbitrary-state emulation per manifest + policy', () => {
      it('mid transition on a flat provider requires explicit policy and warns', async () => {
        const probe = target.build({});
        if (probe.adapter.manifest.issues.arbitraryStates) return; // not applicable to Azure

        // Strict: a mid-workflow transition the provider cannot natively hold must fail loudly.
        const strict = target.build({});
        const a = await strict.adapter.create({ title: 'x', typeRole: 'task' });
        await expect(strict.adapter.transition(a.id, target.mappedMidRole)).rejects.toBeInstanceOf(
          CapabilityGapError,
        );

        // Emulated: it proceeds and logs a warning (never silent).
        const emu = target.build(emulateStates);
        const b = await emu.adapter.create({ title: 'x', typeRole: 'task' });
        await emu.adapter.transition(b.id, target.mappedMidRole);
        expect(emu.logger.entries.some((e) => e.level === 'warn')).toBe(true);
      });
    });

    it('declares the comments and issueLinks capabilities', () => {
      const { adapter } = target.build({});
      expect(typeof adapter.manifest.issues.comments).toBe('boolean');
      expect(typeof adapter.manifest.issues.issueLinks).toBe('boolean');
      expect(typeof adapter.manifest.issues.assignment).toBe('boolean');
    });

    it('derives the canonical branch name (<prefix>/<id>-<slug>) on every read', async () => {
      const { adapter } = target.build({});
      const issue = await adapter.create({ title: 'Añadir búsqueda çok iyi', typeRole: 'task' });
      // Deterministic naming is the point: same item -> same name, everywhere. The prefix follows
      // the REVERSE-resolved type role (flat providers may collapse types), never an invented one.
      expect(issue.typeRole).toBeDefined();
      const prefix =
        issue.typeRole === undefined ? undefined : BRANCH_TYPE_PREFIXES[issue.typeRole];
      if (prefix === undefined) {
        expect(issue.branchName).toBeUndefined();
      } else {
        expect(issue.branchName).toBe(`${prefix}/${issue.id}-anadir-busqueda-cok-iyi`);
      }
      const fetched = await adapter.get(issue.id);
      expect(fetched.branchName).toBe(issue.branchName);
    });

    describe('iteration/sprint handling per manifest + policy', () => {
      it('lists + assigns + queries iterations natively, or negotiates the gap', async () => {
        const probe = target.build({});
        if (probe.adapter.manifest.issues.sprints) {
          const iterations = await probe.adapter.iterations();
          expect(iterations.length).toBeGreaterThan(0);
          const current = await probe.adapter.currentIteration();
          expect(current?.current).toBe(true);

          const issue = await probe.adapter.create({ title: 'sprintable', typeRole: 'task' });
          // '@current' resolves to the active iteration's path in the core.
          const moved = await probe.adapter.setIteration(issue.id, ITERATION_CURRENT);
          expect(moved.iteration).toBe(current?.path);

          const inSprint = await probe.adapter.query({ iteration: current?.path });
          expect(inSprint.some((i) => i.id === issue.id)).toBe(true);
          return;
        }

        // No sprints: strict errors loudly; degrade returns empty / unchanged, never silent.
        await expect(probe.adapter.iterations()).rejects.toBeInstanceOf(CapabilityGapError);
        const soft = target.build({ sprints: { kind: 'degrade' } });
        expect(await soft.adapter.iterations()).toEqual([]);
        expect(await soft.adapter.currentIteration()).toBeUndefined();
        expect(soft.logger.entries.some((e) => e.level === 'warn')).toBe(true);
      });
    });

    describe('assignment handling per manifest + policy', () => {
      it('assigns natively, or negotiates the gap (degrade warns, strict errors)', async () => {
        const probe = target.build({});
        const issue = await probe.adapter.create({ title: 'assign me', typeRole: 'task' });

        if (probe.adapter.manifest.issues.assignment) {
          const assigned = await probe.adapter.assign(issue.id, 'dev@example.com');
          expect(assigned.assignee).toBe('dev@example.com');
          // The '@me' sentinel must resolve to a concrete current-user handle on write (task-start
          // assigns the starter with it) — never persisted literally as '@me'.
          const mine = await probe.adapter.assign(issue.id, ASSIGNEE_ME);
          expect(mine.assignee).toBeTruthy();
          expect(mine.assignee).not.toBe(ASSIGNEE_ME);
          // The ownership round-trip: what '@me' writes must read back EQUAL to whoAmI(). Ownership
          // checks ("is this item mine?" — task-start's takeover guard) compare exactly these two, so
          // an adapter whose write-handle and read-handle differ in form would wrongly report every
          // self-owned item as someone else's.
          const me = await probe.adapter.whoAmI();
          expect(me).toBeTruthy();
          const reloaded = await probe.adapter.get(issue.id);
          expect(reloaded.assignee).toBe(me);
          return;
        }

        // Strict policy -> loud failure, never silent.
        await expect(probe.adapter.assign(issue.id, 'dev@example.com')).rejects.toBeInstanceOf(
          CapabilityGapError,
        );

        // Degrade -> assignment dropped with a warning, issue returned unchanged.
        const soft = target.build({ assignment: { kind: 'degrade' } });
        const other = await soft.adapter.create({ title: 'assign me', typeRole: 'task' });
        const result = await soft.adapter.assign(other.id, 'dev@example.com');
        expect(result.assignee).toBeUndefined();
        expect(soft.logger.entries.some((e) => e.level === 'warn')).toBe(true);
      });
    });

    it('comment adds a comment and returns it normalized', async () => {
      const { adapter } = target.build({});
      const issue = await adapter.create({ title: 'x', typeRole: 'task' });
      const comment = await adapter.comment(issue.id, 'hello there');
      expect(comment.id).toBeTruthy();
      expect(comment.body).toBe('hello there');
    });

    it('query filters by role and by type role', async () => {
      const { adapter } = target.build({ ...emulateStates, ...emulateTypeFiltering });
      const issue = await adapter.create({ title: 'q', typeRole: 'task' });
      await adapter.transition(issue.id, target.mappedMidRole);

      const byRole = await adapter.query({ role: target.mappedMidRole });
      expect(byRole.some((i) => i.id === issue.id)).toBe(true);

      const byType = await adapter.query({ typeRole: 'task' });
      expect(byType.some((i) => i.id === issue.id)).toBe(true);
    });

    it('query filters by assignee when the provider supports assignment', async () => {
      const { adapter } = target.build({});
      if (!adapter.manifest.issues.assignment) return;
      const mine = await adapter.create({ title: 'mine', typeRole: 'task' });
      await adapter.create({ title: 'unassigned', typeRole: 'task' });
      await adapter.assign(mine.id, 'dev@example.com');

      const byAssignee = await adapter.query({ assignee: 'dev@example.com' });
      expect(byAssignee.some((i) => i.id === mine.id)).toBe(true);
      expect(byAssignee.every((i) => i.assignee === 'dev@example.com')).toBe(true);
    });

    describe('link handling per manifest + policy', () => {
      it('native links succeed; flat providers emulate or error', async () => {
        const probe = target.build({});
        const a = await probe.adapter.create({ title: 'a', typeRole: 'task' });
        const b = await probe.adapter.create({ title: 'b', typeRole: 'task' });

        if (probe.adapter.manifest.issues.issueLinks) {
          await expect(probe.adapter.link(a.id, b.id, 'relates')).resolves.toBeUndefined();
          return;
        }

        // Flat provider, strict policy -> loud failure, never silent.
        await expect(probe.adapter.link(a.id, b.id, 'relates')).rejects.toBeInstanceOf(
          CapabilityGapError,
        );

        // Flat provider, emulate:labels -> link encoded as a label on the source + a warning, and
        // the emulation must NOT clobber the issue's workflow-role discriminator.
        const emu = target.build({
          issueLinks: { kind: 'emulate', strategy: 'labels' },
          arbitraryStates: { kind: 'emulate', strategy: 'labels' },
        });
        const ea = await emu.adapter.create({ title: 'a', typeRole: 'task' });
        const eb = await emu.adapter.create({ title: 'b', typeRole: 'task' });
        await emu.adapter.transition(ea.id, target.mappedMidRole);
        await emu.adapter.link(ea.id, eb.id, 'blocks');
        const fetched = await emu.adapter.get(ea.id);
        expect(fetched.labels.some((l) => l.startsWith('blocks:'))).toBe(true);
        expect(fetched.role).toBe(target.mappedMidRole);
        expect(emu.logger.entries.some((e) => e.level === 'warn')).toBe(true);
      });
    });
  });
}
