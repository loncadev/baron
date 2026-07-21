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
  credentialsPath,
  gitConfigPath,
  gitignorePath,
  policyPath,
} from './paths.js';

const ROOT = '/repo';

/** A complete credential set so ensureCredentials is a no-op (the introspector is injected anyway). */
const GH_ENV = { GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_TOKEN: 't' };
const AZ_ENV = {
  AZURE_DEVOPS_ORG: 'o',
  AZURE_DEVOPS_PROJECT: 'p',
  AZURE_DEVOPS_REPO: 'r',
  AZURE_DEVOPS_TOKEN: 't',
};

describe('runInit', () => {
  it('writes a loader-valid policy after confirmation and scaffolds credentials', async () => {
    const fs = memoryFileSystem();
    const prompter = scriptedPrompter([true]);
    const result = await runInit({
      root: ROOT,
      issuesProvider: 'github',
      fs,
      env: GH_ENV,
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
      env: GH_ENV,
      prompter: scriptedPrompter([true]),
      introspector: createMemoryIntrospector(githubIntrospectionFixture),
    });
    expect(ghFs.read(policyPath(ROOT))).toContain('"gapPolicy"');

    const azFs = memoryFileSystem();
    await runInit({
      root: ROOT,
      issuesProvider: 'azure-devops',
      fs: azFs,
      env: AZ_ENV,
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
      env: GH_ENV,
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
      env: GH_ENV,
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
      env: GH_ENV,
      prompter: scriptedPrompter([]),
      force: true,
      introspector: createMemoryIntrospector(githubIntrospectionFixture),
    });
    expect(result.written).toBe(true);
    expect(fs.read(policyPath(ROOT))).toContain('"providers"');
  });

  it('writes a Baron steering block to AGENTS.md when confirmed', async () => {
    const fs = memoryFileSystem();
    // Two confirms: [write policy, add AGENTS.md steering].
    const result = await runInit({
      root: ROOT,
      issuesProvider: 'github',
      fs,
      env: GH_ENV,
      prompter: scriptedPrompter([true, true]),
      introspector: createMemoryIntrospector(githubIntrospectionFixture),
    });
    expect(result.written).toBe(true);
    const agents = fs.read(`${ROOT}/AGENTS.md`) as string;
    expect(agents).toContain('Work tracking — route through Baron');
    expect(agents).toContain('<!-- baron:begin');
    expect(agents).toContain('<!-- baron:end -->');
    // Provider-specific note derived from the manifest: GitHub roles ride labels and has no sprints,
    // so the agent is told that empty sprint results are expected, not a bug.
    expect(agents).toContain('provider: `github`');
    expect(agents).toContain('roles ride labels');
    expect(agents).toContain('sprints are NOT available');
  });

  it('refreshes the steering block idempotently, preserving surrounding content', async () => {
    // A pre-existing AGENTS.md with the user's own content + a stale Baron block.
    const stale =
      '# My project\n\nSome rules.\n\n<!-- baron:begin — managed by `baron init`; edit outside these markers -->\nOLD STALE BARON TEXT\n<!-- baron:end -->\n\nMore of my rules.\n';
    const fs = memoryFileSystem({ [`${ROOT}/AGENTS.md`]: stale });
    await runInit({
      root: ROOT,
      issuesProvider: 'github',
      fs,
      env: GH_ENV,
      prompter: scriptedPrompter([true, true]),
      introspector: createMemoryIntrospector(githubIntrospectionFixture),
    });
    const agents = fs.read(`${ROOT}/AGENTS.md`) as string;
    expect(agents).toContain('# My project'); // user content preserved
    expect(agents).toContain('More of my rules.');
    expect(agents).not.toContain('OLD STALE BARON TEXT'); // stale block replaced
    expect(agents).toContain('route through Baron');
    // Exactly one block — no duplication.
    expect(agents.match(/<!-- baron:begin/g)).toHaveLength(1);
  });

  it('gathers missing credentials in one run: detects owner/repo from git, prompts for the token', async () => {
    // No credentials pre-set. init must write .baron/credentials itself: owner/repo from the git
    // remote, the token from a (hidden) prompt — so the user runs one command, not "hand-make the
    // file, then init".
    const fs = memoryFileSystem({
      [gitConfigPath(ROOT)]: '[remote "origin"]\n\turl = https://github.com/acme/widgets.git\n',
    });
    const prompter = scriptedPrompter([true], ['ghp_secret_value']); // confirm write; token answer
    const result = await runInit({
      root: ROOT,
      issuesProvider: 'github',
      fs,
      env: {},
      prompter,
      introspector: createMemoryIntrospector(githubIntrospectionFixture),
    });
    expect(result.written).toBe(true);
    const creds = fs.read(credentialsPath(ROOT)) as string;
    expect(creds).toContain('GITHUB_OWNER=acme'); // detected, not typed
    expect(creds).toContain('GITHUB_REPO=widgets');
    expect(creds).toContain('GITHUB_TOKEN=ghp_secret_value');
    expect(fs.read(gitignorePath(ROOT))).toContain(CREDENTIALS_IGNORE_ENTRY);
    // Trust + guidance: before prompting for a token, init must tell the user where to get one and
    // that the token is never committed — a first-time user should not have to guess which token.
    const said = prompter.notes.join('\n');
    expect(said).toContain('github.com/settings/personal-access-tokens');
    expect(said).toMatch(/gitignored|never committed/i);
  });

  it('fails loudly when a required credential is left blank rather than introspecting with it empty', async () => {
    const fs = memoryFileSystem({
      [gitConfigPath(ROOT)]: '[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n',
    });
    const prompter = scriptedPrompter([], ['']); // empty token
    await expect(
      runInit({
        root: ROOT,
        issuesProvider: 'github',
        fs,
        env: {},
        prompter,
        introspector: createMemoryIntrospector(githubIntrospectionFixture),
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIALS_MISSING' });
  });

  it('does not duplicate the gitignore entry when it already exists', async () => {
    const fs = memoryFileSystem({
      [gitignorePath(ROOT)]: `node_modules\n${CREDENTIALS_IGNORE_ENTRY}\n`,
    });
    await runInit({
      root: ROOT,
      issuesProvider: 'github',
      fs,
      env: GH_ENV,
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
