import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaronError, type BaronPolicyFile, serializePolicy } from '@baron/core';
import { policyPath } from '@baron/providers';
import { describe, expect, it } from 'vitest';
import { loadIssuesPort } from './load.js';

const githubPolicy: BaronPolicyFile = {
  version: 1,
  providers: { issues: 'github' },
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

describe('loadIssuesPort', () => {
  it('throws POLICY_NOT_FOUND when no policy exists', () => {
    withTempRoot((root) => {
      expect(() => loadIssuesPort(root, dummyEnv)).toThrow(BaronError);
    });
  });

  it('builds a live issues port from a committed policy', () => {
    withTempRoot((root) => {
      mkdirSync(join(root, '.baron'), { recursive: true });
      writeFileSync(policyPath(root), serializePolicy(githubPolicy), 'utf8');
      const port = loadIssuesPort(root, dummyEnv);
      expect(port.manifest.provider).toBe('github');
    });
  });
});
