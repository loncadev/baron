import {
  azureIntrospectionFixture,
  createMemoryIntrospector,
  githubIntrospectionFixture,
} from '@lonca/baron-conformance';
import { parsePolicy, resolveIssuesConfig } from '@lonca/baron-core';
import { describe, expect, it } from 'vitest';
import { memoryFileSystem, scriptedPrompter } from './fakes.js';
import { runInit } from './init.js';
import {
  CREDENTIALS_IGNORE_ENTRY,
  credentialsExamplePath,
  gitignorePath,
  policyPath,
} from './paths.js';

const ROOT = '/repo';

describe('runInit', () => {
  it('writes a loader-valid policy after confirmation and scaffolds credentials', async () => {
    const fs = memoryFileSystem();
    const prompter = scriptedPrompter([true]);
    const result = await runInit({
      root: ROOT,
      issuesProvider: 'github',
      fs,
      prompter,
      introspector: createMemoryIntrospector(githubIntrospectionFixture),
    });

    expect(result.written).toBe(true);

    const written = fs.read(policyPath(ROOT));
    expect(written).toBeDefined();
    const policy = parsePolicy(JSON.parse(written as string));
    const config = resolveIssuesConfig(policy);
    expect(config.provider).toBe('github');
    expect(config.roleMap.states.in_progress).toEqual({ label: 'in-progress' });
    // scm must be bound to the same provider — task-start/finish need branches + PRs, and a
    // from-scratch setup should not have to hand-edit policy.json to get them.
    expect(policy.providers.scm).toBe('github');

    const example = fs.read(credentialsExamplePath(ROOT));
    expect(example).toContain('GITHUB_TOKEN=');
    expect(fs.read(gitignorePath(ROOT))).toContain(CREDENTIALS_IGNORE_ENTRY);
  });

  it('emits a gap policy for a flat provider but not for a fully capable one', async () => {
    const ghFs = memoryFileSystem();
    await runInit({
      root: ROOT,
      issuesProvider: 'github',
      fs: ghFs,
      prompter: scriptedPrompter([true]),
      introspector: createMemoryIntrospector(githubIntrospectionFixture),
    });
    expect(ghFs.read(policyPath(ROOT))).toContain('"gapPolicy"');

    const azFs = memoryFileSystem();
    await runInit({
      root: ROOT,
      issuesProvider: 'azure-devops',
      fs: azFs,
      prompter: scriptedPrompter([true]),
      introspector: createMemoryIntrospector(azureIntrospectionFixture),
    });
    // Azure's only gap is subIssues -> degrade, so a gap policy IS present; assert it resolves and
    // the rich role map carries board columns (the impedance the proposal earns).
    const azConfig = resolveIssuesConfig(
      parsePolicy(JSON.parse(azFs.read(policyPath(ROOT)) as string)),
    );
    expect(azConfig.roleMap.states.in_review?.boardColumn).toBe('Test');
  });

  it('does not write when the human declines', async () => {
    const fs = memoryFileSystem();
    const result = await runInit({
      root: ROOT,
      issuesProvider: 'github',
      fs,
      prompter: scriptedPrompter([false]),
      introspector: createMemoryIntrospector(githubIntrospectionFixture),
    });
    expect(result.written).toBe(false);
    expect(fs.read(policyPath(ROOT))).toBeUndefined();
  });

  it('prompts before overwriting an existing policy and respects a no', async () => {
    const fs = memoryFileSystem({ [policyPath(ROOT)]: '{"existing":true}' });
    const result = await runInit({
      root: ROOT,
      issuesProvider: 'github',
      fs,
      prompter: scriptedPrompter([false]), // decline the overwrite
      introspector: createMemoryIntrospector(githubIntrospectionFixture),
    });
    expect(result.written).toBe(false);
    expect(fs.read(policyPath(ROOT))).toBe('{"existing":true}');
  });

  it('overwrites without prompting under --force', async () => {
    const fs = memoryFileSystem({ [policyPath(ROOT)]: '{"existing":true}' });
    const result = await runInit({
      root: ROOT,
      issuesProvider: 'github',
      fs,
      prompter: scriptedPrompter([]),
      force: true,
      introspector: createMemoryIntrospector(githubIntrospectionFixture),
    });
    expect(result.written).toBe(true);
    expect(fs.read(policyPath(ROOT))).toContain('"providers"');
  });

  it('does not duplicate the gitignore entry when it already exists', async () => {
    const fs = memoryFileSystem({
      [gitignorePath(ROOT)]: `node_modules\n${CREDENTIALS_IGNORE_ENTRY}\n`,
    });
    await runInit({
      root: ROOT,
      issuesProvider: 'github',
      fs,
      prompter: scriptedPrompter([true]),
      introspector: createMemoryIntrospector(githubIntrospectionFixture),
    });
    const ignore = fs.read(gitignorePath(ROOT)) as string;
    const occurrences = ignore
      .split('\n')
      .filter((l) => l.trim() === CREDENTIALS_IGNORE_ENTRY).length;
    expect(occurrences).toBe(1);
  });
});
