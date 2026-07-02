import {
  azureIntrospectionFixture,
  createMemoryIntrospector,
  githubIntrospectionFixture,
} from '@lonca/baron-conformance';
import { BaronError, WORK_ITEM_TYPE_ROLES } from '@lonca/baron-core';
import { describe, expect, it } from 'vitest';
import { runDoctor } from './doctor.js';
import { memoryFileSystem, scriptedPrompter } from './fakes.js';
import { runInit } from './init.js';

const ROOT = '/repo';

/** Seed a memory fs with a freshly-written policy for the given provider/fixture. */
async function seededFs(provider: string, fixture = githubIntrospectionFixture) {
  const fs = memoryFileSystem();
  await runInit({
    root: ROOT,
    issuesProvider: provider,
    fs,
    prompter: scriptedPrompter([]),
    force: true,
    introspector: createMemoryIntrospector(fixture),
  });
  return fs;
}

describe('runDoctor', () => {
  it('reports no drift when the policy still matches the live provider', async () => {
    const fs = await seededFs('azure-devops', azureIntrospectionFixture);
    const report = await runDoctor({
      root: ROOT,
      fs,
      introspector: createMemoryIntrospector(azureIntrospectionFixture),
    });
    expect(report.ok).toBe(true);
    expect(report.drift).toEqual([]);
    expect(report.checks).toBeGreaterThan(0);
  });

  it('flags a native state that no longer exists', async () => {
    const fs = await seededFs('azure-devops', azureIntrospectionFixture);
    const drifted = {
      ...azureIntrospectionFixture,
      states: azureIntrospectionFixture.states.filter((s) => s.name !== 'Closed'),
    };
    const report = await runDoctor({
      root: ROOT,
      fs,
      introspector: createMemoryIntrospector(drifted),
    });
    expect(report.ok).toBe(false);
    expect(report.drift.some((d) => d.includes('Closed'))).toBe(true);
  });

  it('flags a native type that no longer exists', async () => {
    const fs = await seededFs('azure-devops', azureIntrospectionFixture);
    const drifted = {
      ...azureIntrospectionFixture,
      workItemTypes: azureIntrospectionFixture.workItemTypes.filter((t) => t.name !== 'Task'),
    };
    const report = await runDoctor({
      root: ROOT,
      fs,
      introspector: createMemoryIntrospector(drifted),
    });
    expect(report.ok).toBe(false);
    expect(report.drift.some((d) => d.includes('Task'))).toBe(true);
  });

  it('flags a board column that no longer exists', async () => {
    const fs = await seededFs('azure-devops', azureIntrospectionFixture);
    const drifted = {
      ...azureIntrospectionFixture,
      boardColumns: (azureIntrospectionFixture.boardColumns ?? []).filter((c) => c !== 'Test'),
    };
    const report = await runDoctor({
      root: ROOT,
      fs,
      introspector: createMemoryIntrospector(drifted),
    });
    expect(report.ok).toBe(false);
    expect(report.drift.some((d) => d.includes('Test'))).toBe(true);
  });

  it('skips native-state checks for a label-discriminated provider', async () => {
    const fs = await seededFs('github', githubIntrospectionFixture);
    const report = await runDoctor({
      root: ROOT,
      fs,
      introspector: createMemoryIntrospector(githubIntrospectionFixture),
    });
    expect(report.ok).toBe(true);
    // Only the type map is checkable on a flat provider; no native states or columns. One check
    // per abstract type role (all collapse onto GitHub's single 'issue' type).
    expect(report.checks).toBe(WORK_ITEM_TYPE_ROLES.length);
  });

  it('throws an actionable error when no policy exists', async () => {
    const fs = memoryFileSystem();
    await expect(
      runDoctor({
        root: ROOT,
        fs,
        introspector: createMemoryIntrospector(githubIntrospectionFixture),
      }),
    ).rejects.toBeInstanceOf(BaronError);
  });
});
