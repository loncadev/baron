import {
  CapabilityGapError,
  type GapPolicy,
  type IssuesPort,
  type RecordingLogger,
  RoleMappingError,
  type WorkflowRole,
} from '@baron/core';
import { describe, expect, it } from 'vitest';

export interface IssuesConformanceTarget {
  readonly label: string;
  /** Build a fresh adapter (in-memory transport) with the given gap policy, plus its logger. */
  build(gapPolicy: GapPolicy): { adapter: IssuesPort; logger: RecordingLogger };
  /** A mid-workflow role that IS mapped for this provider (e.g. 'in_review'). */
  readonly mappedMidRole: WorkflowRole;
  /** The terminal role (e.g. 'done'). */
  readonly mappedDoneRole: WorkflowRole;
  /** A role deliberately left out of the role map (e.g. 'blocked'). */
  readonly unmappedRole: WorkflowRole;
}

const emulateStates: GapPolicy = { arbitraryStates: { kind: 'emulate', strategy: 'labels' } };

/**
 * The contract every `issues` adapter must satisfy. It asserts provider-agnostic behavior while
 * branching on the adapter's own manifest, so the same suite proves correct-but-different handling
 * for a rich provider (Azure) and a flat one (GitHub).
 */
export function runIssuesConformance(target: IssuesConformanceTarget): void {
  describe(`issues conformance: ${target.label}`, () => {
    it('create returns a normalized issue', async () => {
      const { adapter } = target.build({});
      const issue = await adapter.create({ title: 'Hello', typeRole: 'task' });
      expect(issue.provider).toBe(adapter.manifest.provider);
      expect(issue.key).toBeTruthy();
      expect(issue.title).toBe('Hello');
      expect(issue.nativeType).toBeTruthy();
      // Reverse type-role resolution is best-effort: providers that collapse every type role
      // onto one native type (GitHub -> 'issue') cannot round-trip the exact role from the native
      // type alone. Faithful round-trip on such providers needs label emulation (same pattern as
      // hierarchy) and is tracked as a follow-up; here we only require *a* valid resolved role.
      expect(issue.typeRole).toBeDefined();
    });

    it('transition to a mapped role resolves that role back', async () => {
      const { adapter } = target.build(emulateStates);
      const issue = await adapter.create({ title: 'x', typeRole: 'task' });
      const moved = await adapter.transition(issue.id, target.mappedMidRole);
      expect(moved.role).toBe(target.mappedMidRole);
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
  });
}
