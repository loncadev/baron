import type { CapabilityManifest, CapabilityName, IssuesTransport } from '@lonca/baron-core';
import { describe, expect, it } from 'vitest';

export interface TransportFidelityTarget {
  readonly label: string;
  readonly manifest: CapabilityManifest;
  /**
   * The LIVE transport factory, called with placeholder credentials. Constructing one performs no
   * I/O — it only wires a client — which is what makes this checkable without a network.
   */
  build(): IssuesTransport;
}

/**
 * Transport methods a declared capability cannot be honoured without.
 *
 * `nativeLabels` requires REMOVAL as well as addition: the base adapter clears the previous role's
 * label on a transition, and the orthogonal blocked flag has to be clearable at all. Azure declared
 * the capability, implemented only `addLabel`, and turned blocking into a one-way door that could
 * only be undone in the provider's own UI.
 */
const REQUIRED_METHODS: Partial<Record<CapabilityName, readonly (keyof IssuesTransport)[]>> = {
  nativeLabels: ['addLabel', 'removeLabel'],
  sprints: ['listIterations', 'setIteration'],
  issueLinks: ['linkIssues'],
  assignment: ['assignIssue'],
};

/**
 * The half of adapter fidelity that is structurally checkable, and that the issues suite by
 * construction cannot see.
 *
 * `runIssuesConformance` builds every adapter on `createMemoryTransport`, which implements
 * everything — so it proves the translation layer and says nothing about whether the LIVE transport
 * can do what its manifest claims. Four defects came from that blind spot before this existed
 * (#30, #32, #42, #55), each found by using Baron rather than by the suite.
 *
 * What this cannot check is whether a method that exists behaves as the manifest implies — that a
 * `queryIssues` given a native type actually filters by it, or that `createIssue` persists the type
 * it is handed. Those are the gated smoke tests' job, and saying so here is better than leaving it
 * an assumption: a green run means the shape is right, not that the provider agrees.
 */
export function runTransportFidelityConformance(target: TransportFidelityTarget): void {
  describe(`transport fidelity: ${target.label}`, () => {
    it('implements every transport method the capabilities it declares require', () => {
      const transport = target.build();
      const missing: string[] = [];
      for (const [capability, methods] of Object.entries(REQUIRED_METHODS)) {
        if (!target.manifest.issues[capability as CapabilityName]) continue;
        for (const method of methods ?? []) {
          if (typeof transport[method] !== 'function') missing.push(`${capability} -> ${method}`);
        }
      }
      expect(missing, `${target.label} claims capabilities its transport cannot honour`).toEqual(
        [],
      );
    });

    it('implements the methods every adapter needs regardless of what it declares', () => {
      const transport = target.build();
      for (const method of [
        'createIssue',
        'getIssue',
        'applyTarget',
        'addComment',
        'queryIssues',
        'updateIssue',
        'currentUser',
      ] as const) {
        expect(typeof transport[method], `${target.label}.${method}`).toBe('function');
      }
    });
  });
}
