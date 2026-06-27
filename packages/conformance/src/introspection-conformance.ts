import {
  type CapabilityManifest,
  type Introspector,
  parsePolicy,
  proposePolicy,
  resolveIssuesConfig,
} from '@baron/core';
import { describe, expect, it } from 'vitest';

export interface IntrospectionConformanceTarget {
  readonly label: string;
  readonly manifest: CapabilityManifest;
  /** Introspector primed with the provider's fixture vocabulary. */
  build(): Introspector;
}

/**
 * The contract every provider's introspection + proposal must satisfy: whatever the provider's
 * shape, `baron init`'s proposal must yield a policy that the loader accepts and can resolve into a
 * working issues config. Like the issues suite, it branches on the manifest so one suite proves a
 * rich provider (Azure) and a flat one (GitHub) at once.
 */
export function runIntrospectionConformance(target: IntrospectionConformanceTarget): void {
  describe(`introspection conformance: ${target.label}`, () => {
    it('proposes a policy the loader accepts and can resolve', async () => {
      const introspection = await target.build().introspect();
      const proposal = proposePolicy(introspection, target.manifest);

      const policyObject = {
        version: 1 as const,
        providers: { issues: proposal.provider },
        roleMap: { [proposal.provider]: proposal.roleMap },
        typeMap: { [proposal.provider]: proposal.typeMap },
        gapPolicy: { [proposal.provider]: proposal.gapPolicy },
      };

      // Round-trips through JSON to prove the proposal is serializable, not just in-memory valid.
      const parsed = parsePolicy(JSON.parse(JSON.stringify(policyObject)));
      const config = resolveIssuesConfig(parsed);
      expect(config.provider).toBe(proposal.provider);
    });

    it('maps the core mid-workflow and terminal roles', async () => {
      const introspection = await target.build().introspect();
      const { roleMap } = proposePolicy(introspection, target.manifest);
      expect(roleMap.states.in_progress).toBeDefined();
      expect(roleMap.states.in_review).toBeDefined();
      expect(roleMap.states.done).toBeDefined();
    });

    it("uses the provider's discriminator key for an arbitrary-state provider, labels otherwise", async () => {
      const introspection = await target.build().introspect();
      const { roleMap } = proposePolicy(introspection, target.manifest);
      if (target.manifest.issues.arbitraryStates) {
        expect(roleMap.stateKey).toBe(introspection.stateKey);
      } else {
        expect(roleMap.stateKey).toBe('label');
      }
    });

    it('attaches a board column when the provider has a separate board', async () => {
      const introspection = await target.build().introspect();
      const { roleMap } = proposePolicy(introspection, target.manifest);
      if (target.manifest.issues.separateBoardColumn) {
        const hasColumn = Object.values(roleMap.states).some((t) => t?.boardColumn !== undefined);
        expect(hasColumn).toBe(true);
      }
    });

    it('proposes an explicit behavior for every unsupported capability (never silent)', async () => {
      const introspection = await target.build().introspect();
      const { gapPolicy } = proposePolicy(introspection, target.manifest);
      const caps = target.manifest.issues;
      if (!caps.hierarchy) expect(gapPolicy.hierarchy).toBeDefined();
      if (!caps.arbitraryStates) expect(gapPolicy.arbitraryStates).toBeDefined();
      if (!caps.sprints) expect(gapPolicy.sprints).toBeDefined();
    });

    it('records human-confirmable notes for its guesses', async () => {
      const introspection = await target.build().introspect();
      const proposal = proposePolicy(introspection, target.manifest);
      expect(Array.isArray(proposal.notes)).toBe(true);
    });
  });
}
