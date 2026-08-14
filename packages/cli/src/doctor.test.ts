import {
  azureIntrospectionFixture,
  createMemoryIntrospector,
  githubIntrospectionFixture,
} from '@lonca/baron-conformance';
import {
  BaronError,
  type CredentialCapability,
  type CredentialProbe,
  type CredentialStatus,
  WORK_ITEM_TYPE_ROLES,
} from '@lonca/baron-core';
import { describe, expect, it } from 'vitest';
import { runDoctor } from './doctor.js';
import { memoryFileSystem, scriptedPrompter } from './fakes.js';
import { runInit } from './init.js';

const ROOT = '/repo';

/** A complete credential set for both P0 providers, so init's credential gathering is a no-op. */
const FULL_ENV = {
  GITHUB_OWNER: 'o',
  GITHUB_REPO: 'r',
  GITHUB_TOKEN: 't',
  AZURE_DEVOPS_ORG: 'o',
  AZURE_DEVOPS_PROJECT: 'p',
  AZURE_DEVOPS_REPO: 'r',
  AZURE_DEVOPS_TOKEN: 't',
};

/**
 * No probe at all — what a provider that cannot report credential permissions looks like. Every
 * drift-focused case passes this so it never reaches the live registry (and the network) for a
 * credential answer it is not asserting on.
 */
const NO_PROBE = () => undefined;

/** A probe that answers every requested capability with one fixed status. */
function probeAnswering(status: CredentialStatus): () => CredentialProbe {
  return () => ({
    probe: async (capabilities: readonly CredentialCapability[]) =>
      capabilities.map((capability) => ({
        capability,
        status,
        nativePermission: 'Contents: Read and write',
      })),
  });
}

/** Seed a memory fs with a freshly-written policy for the given provider/fixture. */
async function seededFs(provider: string, fixture = githubIntrospectionFixture) {
  const fs = memoryFileSystem();
  await runInit({
    root: ROOT,
    issuesProvider: provider,
    fs,
    env: FULL_ENV,
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
      probeFor: NO_PROBE,
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
      probeFor: NO_PROBE,
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
      probeFor: NO_PROBE,
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
      probeFor: NO_PROBE,
    });
    expect(report.ok).toBe(false);
    expect(report.drift.some((d) => d.includes('Test'))).toBe(true);
  });

  // A label-keyed provider still PINS a native state where it has one: GitHub's
  // `done: { state: 'closed', label: 'done' }` is a real state its introspector reports. Gating the
  // check on the map's discriminator left that unchecked on every label-keyed install.
  it('checks a native state a label-discriminated provider still pins', async () => {
    const fs = await seededFs('github', githubIntrospectionFixture);
    const report = await runDoctor({
      root: ROOT,
      fs,
      introspector: createMemoryIntrospector(githubIntrospectionFixture),
      probeFor: NO_PROBE,
    });
    expect(report.ok).toBe(true);
    // One check per abstract type role (all collapse onto GitHub's single 'issue' type), plus the
    // one role whose target pins a native state. Labels themselves are Baron-managed and check nothing.
    expect(report.checks).toBe(WORK_ITEM_TYPE_ROLES.length + 1);
  });

  it('flags that pinned native state when the provider drops it', async () => {
    const fs = await seededFs('github', githubIntrospectionFixture);
    const report = await runDoctor({
      root: ROOT,
      fs,
      introspector: createMemoryIntrospector({
        ...githubIntrospectionFixture,
        states: githubIntrospectionFixture.states.filter((s) => s.name !== 'closed'),
      }),
      probeFor: NO_PROBE,
    });
    expect(report.ok).toBe(false);
    expect(report.drift.some((d) => d.includes('closed'))).toBe(true);
  });

  // The bug this suite exists to prevent: a policy that matches the provider perfectly, reported as
  // OK, one command before the first write fails on a permission the credential never had.
  it('fails when the credential cannot do what a bound port requires', async () => {
    const fs = await seededFs('github', githubIntrospectionFixture);
    const report = await runDoctor({
      root: ROOT,
      fs,
      introspector: createMemoryIntrospector(githubIntrospectionFixture),
      probeFor: probeAnswering('denied'),
    });
    expect(report.drift).toEqual([]);
    expect(report.ok).toBe(false);
    expect(report.credentials.every((f) => f.status === 'denied')).toBe(true);
    // The report has to carry the fix, not just the refusal.
    expect(report.credentials[0]?.nativePermission).toBe('Contents: Read and write');
  });

  it('passes when every required capability is granted', async () => {
    const fs = await seededFs('github', githubIntrospectionFixture);
    const report = await runDoctor({
      root: ROOT,
      fs,
      introspector: createMemoryIntrospector(githubIntrospectionFixture),
      probeFor: probeAnswering('granted'),
    });
    expect(report.ok).toBe(true);
    expect(report.credentials.map((f) => f.capability).sort()).toEqual([
      'issues:read',
      'issues:write',
      'scm:read',
      'scm:write',
    ]);
  });

  // 'we could not check' must reach the report as its own outcome. Reporting nothing would read as
  // 'nothing was wrong', which is the same lie in a quieter voice.
  it('reports unconfirmed capabilities rather than assuming them', async () => {
    const fs = await seededFs('github', githubIntrospectionFixture);
    const report = await runDoctor({
      root: ROOT,
      fs,
      introspector: createMemoryIntrospector(githubIntrospectionFixture),
      probeFor: NO_PROBE,
    });
    expect(report.credentials.length).toBeGreaterThan(0);
    expect(report.credentials.every((f) => f.status === 'unknown')).toBe(true);
    expect(report.credentials.every((f) => (f.detail ?? '').length > 0)).toBe(true);
  });

  it('treats a probe that throws as unconfirmed, not as failure', async () => {
    const fs = await seededFs('github', githubIntrospectionFixture);
    const report = await runDoctor({
      root: ROOT,
      fs,
      introspector: createMemoryIntrospector(githubIntrospectionFixture),
      probeFor: () => ({
        probe: async () => {
          throw new Error('network down');
        },
      }),
    });
    expect(report.ok).toBe(true);
    expect(report.credentials.every((f) => f.status === 'unknown')).toBe(true);
    expect(report.credentials[0]?.detail).toContain('network down');
  });

  // Coverage is the question drift never asks: not "does what is mapped still exist?" but "is
  // anything missing from the map?" — which only announces itself when a run fails.
  it('reports a type role the policy maps to nothing', async () => {
    const fs = await seededFs('github', githubIntrospectionFixture);
    const policy = JSON.parse(fs.read(`${ROOT}/.baron/policy.json`) as string);
    const { story: _unmapped, ...withoutStory } = policy.typeMap.github;
    policy.typeMap.github = withoutStory;
    fs.write(`${ROOT}/.baron/policy.json`, JSON.stringify(policy));

    const report = await runDoctor({
      root: ROOT,
      fs,
      introspector: createMemoryIntrospector(githubIntrospectionFixture),
      probeFor: NO_PROBE,
    });
    expect(report.unmappedTypeRoles).toEqual(['story']);
    // Not drift: the policy is internally valid, and on some providers a role has no native
    // equivalent. Reported, never fatal.
    expect(report.drift).toEqual([]);
    expect(report.ok).toBe(true);
  });

  // The direction that costs an item its branch, and the exact shape of the regression that made
  // task-start refuse every issue in this repository.
  it('reports a native type that no type role maps back from', async () => {
    const fs = await seededFs('github', githubIntrospectionFixture);
    const policy = JSON.parse(fs.read(`${ROOT}/.baron/policy.json`) as string);
    for (const role of Object.keys(policy.typeMap.github)) {
      policy.typeMap.github[role] = 'Task';
    }
    fs.write(`${ROOT}/.baron/policy.json`, JSON.stringify(policy));

    const report = await runDoctor({
      root: ROOT,
      fs,
      introspector: createMemoryIntrospector({
        ...githubIntrospectionFixture,
        workItemTypes: [{ name: 'issue', isDefault: true }, { name: 'Task' }],
      }),
      probeFor: NO_PROBE,
    });
    expect(report.unreachableNativeTypes).toEqual(['issue']);
  });

  it('reports full coverage on a freshly proposed policy', async () => {
    const fs = await seededFs('github', githubIntrospectionFixture);
    const report = await runDoctor({
      root: ROOT,
      fs,
      introspector: createMemoryIntrospector(githubIntrospectionFixture),
      probeFor: NO_PROBE,
    });
    expect(report.unmappedTypeRoles).toEqual([]);
    expect(report.unreachableNativeTypes).toEqual([]);
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
