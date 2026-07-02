import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaronError, type BaronPolicyFile, serializePolicy } from '@lonca/baron-core';
import { policyPath } from '@lonca/baron-providers';
import { describe, expect, it } from 'vitest';
import { loadPorts } from './load.js';

const githubPolicy: BaronPolicyFile = {
  version: 1,
  providers: { issues: 'github', scm: 'github' },
  roleMap: {
    github: {
      stateKey: 'label',
      states: {
        in_progress: { label: 'in-progress' },
        done: { state: 'closed', label: 'done' },
      },
    },
  },
  typeMap: { github: { task: 'issue' } },
};

const dummyEnv = { GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_TOKEN: 't' };

function withTempRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'baron-mcp-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('loadPorts', () => {
  it('throws POLICY_NOT_FOUND when no policy exists', () => {
    withTempRoot((root) => {
      expect(() => loadPorts(root, dummyEnv)).toThrow(BaronError);
    });
  });

  it('builds the issues and scm ports bound by the policy', () => {
    withTempRoot((root) => {
      mkdirSync(join(root, '.baron'), { recursive: true });
      writeFileSync(policyPath(root), serializePolicy(githubPolicy), 'utf8');
      const ports = loadPorts(root, dummyEnv);
      expect(ports.issues?.manifest.provider).toBe('github');
      expect(ports.scm?.manifest.provider).toBe('github');
      // The knowledge loop is always available (local-md store), regardless of provider bindings.
      expect(ports.knowledge).toBeDefined();
    });
  });
});
