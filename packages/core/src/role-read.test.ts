import { describe, expect, it } from 'vitest';
import type { CapabilityManifest } from './capabilities.js';
import type { IssuesProviderConfig, NativeTarget } from './config.js';
import { BaseIssuesAdapter, type IssuesTransport, type NativeIssue } from './ports.js';

/**
 * These cases cannot be expressed in the conformance suite: its in-memory transport only reaches a
 * given state THROUGH Baron's own writes, and `transition` clears stale role labels on the way. The
 * drift here is created BEHIND Baron's back — GitHub closing an item itself when a PR with
 * `Closes #N` merges, or a human reopening one in the UI — so it takes a transport that can report
 * a combination Baron would never write.
 */

const manifest: CapabilityManifest = {
  provider: 'label-keyed',
  issues: {
    hierarchy: false,
    subIssues: false,
    separateBoardColumn: false,
    sprints: false,
    arbitraryStates: false,
    nativeLabels: true,
    comments: true,
    issueLinks: false,
    assignment: true,
  },
};

// A GitHub-shaped map: most roles ride labels, but `done` also pins the native closed state.
const cfg: IssuesProviderConfig = {
  provider: 'label-keyed',
  roleMap: {
    stateKey: 'label',
    states: {
      in_progress: { label: 'in-progress' },
      in_review: { label: 'in-review' },
      done: { state: 'closed', label: 'done' },
    },
  },
  typeMap: { epic: 'issue', story: 'issue', task: 'issue', subtask: 'issue', bug: 'issue' },
  linkMap: {},
  gapPolicy: {},
};

/** Read back an item the provider reports in the given state/label combination. */
function readIssue(discriminator: string, labels: readonly string[]) {
  const native: NativeIssue = {
    id: '12',
    key: '#12',
    title: 'an item the provider changed on its own',
    nativeType: 'issue',
    discriminator,
    labels,
  };
  const transport: IssuesTransport = {
    async createIssue() {
      return native;
    },
    async getIssue() {
      return native;
    },
    async applyTarget(_id: string, _target: NativeTarget) {
      return native;
    },
    async addLabel() {},
    async queryIssues() {
      return [native];
    },
    async addComment(_id: string, body: string) {
      return { id: 'c1', body };
    },
    async assignIssue() {
      return native;
    },
    async setIteration() {
      return native;
    },
    async updateIssue() {
      return native;
    },
    async linkIssues() {},
    async currentUser() {
      return 'nobody';
    },
    async listIterations() {
      return [];
    },
  };
  return new BaseIssuesAdapter(manifest, cfg, transport).get(native.id);
}

describe('role read when the provider changed the item behind Baron', () => {
  it('reads done from the closed state even though a stale in-progress label remains', async () => {
    // The reported bug: a PR merges with `Closes #12`, GitHub closes the item, no transition ever
    // runs — so the label Baron wrote at task-start is still there and used to win the read.
    const issue = await readIssue('closed', ['in-progress', 'type:task']);
    expect(issue.role).toBe('done');
    expect(issue.nativeState).toBe('closed');
    // The label is still reported as-is: the read tells the truth, it does not quietly rewrite it.
    expect(issue.labels).toContain('in-progress');
  });

  it('still reads the label role while the provider state says nothing', async () => {
    const issue = await readIssue('open', ['in-progress']);
    expect(issue.role).toBe('in_progress');
  });

  it('reports no role rather than a stale done for a reopened item', async () => {
    // The mirror case: `done` pins the closed state, so a `done` label on an OPEN item is a
    // leftover from before the reopen. Claiming done here would report finished work as finished
    // twice over; claiming in-flight would invent a role nothing supports.
    const issue = await readIssue('open', ['done']);
    expect(issue.role).toBeUndefined();
  });
});
