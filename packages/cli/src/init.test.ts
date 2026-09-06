import {
  azureIntrospectionFixture,
  createMemoryIntrospector,
  githubIntrospectionFixture,
  scopedIntrospectionFixture,
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

  it('prompts for the provider when issuesProvider is omitted, then proceeds', async () => {
    const fs = memoryFileSystem();
    // No provider passed. The scripted choice picks 'github'; two confirms follow (policy, steering).
    const result = await runInit({
      root: ROOT,
      fs,
      env: GH_ENV,
      prompter: scriptedPrompter([true, true], [], ['github']),
      introspector: createMemoryIntrospector(githubIntrospectionFixture),
    });
    expect(result.written).toBe(true);
    expect(
      resolveIssuesConfig(parsePolicy(JSON.parse(fs.read(policyPath(ROOT)) as string))).provider,
    ).toBe('github');
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
    // Decline the browser sign-in: this case is specifically about the paste-a-token path, which
    // stays available precisely so someone wanting the narrower fine-grained credential can use it.
    const prompter = scriptedPrompter([false, true], ['ghp_secret_value']);
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

  it('stores what a sign-in hands over beside the token, under the keys the provider chose', async () => {
    // A browser-issued token comes with a refresh token and an expiry; init does not know what
    // they mean, only that the provider that wrote them will read them back.
    const fs = memoryFileSystem({
      [gitConfigPath(ROOT)]: '[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n',
    });
    // confirms: sign in via browser? yes; write policy? yes.
    const prompter = scriptedPrompter([true, true]);
    const result = await runInit({
      root: ROOT,
      issuesProvider: 'github',
      fs,
      env: {},
      prompter,
      introspector: createMemoryIntrospector(githubIntrospectionFixture),
      deviceAuth: {
        async authorize(onPrompt) {
          onPrompt({ verificationUri: 'https://example.test/approve', expiresInSeconds: 600 });
          return {
            token: 'tok',
            extras: { X_REFRESH_TOKEN: 'r1', X_TOKEN_EXPIRES_AT: '2026-09-07T00:00:00.000Z' },
          };
        },
      },
    });
    expect(result.written).toBe(true);
    const saved = fs.read(credentialsPath(ROOT)) as string;
    expect(saved).toContain('GITHUB_TOKEN=tok');
    expect(saved).toContain('X_REFRESH_TOKEN=r1');
    expect(saved).toContain('X_TOKEN_EXPIRES_AT=2026-09-07T00:00:00.000Z');
    // A callback flow has no code to show: the note says to approve, not to type.
    expect(prompter.notes.join('\n')).toContain('and approve');
    expect(prompter.notes.join('\n')).not.toContain('enter:');
  });

  it('never offers the browser sign-in on a --force run', async () => {
    // --force means "do not ask me". The device flow is nothing but asking: it waits up to fifteen
    // minutes for a human to approve a code, so offering it where nobody can answer hangs the run
    // rather than degrading. The scripted `true` below is the trap — if the offer is ever made on a
    // forced run, it is accepted, and this test reaches for the network instead of finishing.
    const fs = memoryFileSystem({
      [gitConfigPath(ROOT)]: '[remote "origin"]\n\turl = https://github.com/acme/widgets.git\n',
    });
    const prompter = scriptedPrompter([true], ['ghp_from_the_prompt']);
    await runInit({
      root: ROOT,
      issuesProvider: 'github',
      fs,
      env: {},
      force: true,
      prompter,
      introspector: createMemoryIntrospector(githubIntrospectionFixture),
    });
    expect(fs.read(credentialsPath(ROOT))).toContain('GITHUB_TOKEN=ghp_from_the_prompt');
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

  // The first live Jira run saved a wrong JIRA_SITE, saw a raw fetch error, and on a re-run was
  // asked nothing because nothing was missing. These pin the way out.
  describe('when the provider cannot be read with the credentials just gathered', () => {
    /** Fails on the first call with a provider-shaped error, answers on the second. */
    function flakyIntrospector() {
      let calls = 0;
      return {
        calls: () => calls,
        async introspect() {
          calls += 1;
          if (calls === 1) throw new Error("HTTP 404 reading project 'n'");
          return githubIntrospectionFixture;
        },
      };
    }

    it('offers to re-enter that provider’s credentials on the spot, and tries again with them', async () => {
      const fs = memoryFileSystem({
        [credentialsPath(ROOT)]: 'GITHUB_OWNER=n\nGITHUB_REPO=r\nGITHUB_TOKEN=old\n',
      });
      // confirms: re-enter? yes; write policy? yes. texts: owner, repo, token (empty keeps).
      const prompter = scriptedPrompter([true, true], ['acme', 'widgets', '']);
      const introspector = flakyIntrospector();
      const result = await runInit({
        root: ROOT,
        issuesProvider: 'github',
        fs,
        env: {},
        prompter,
        introspector,
      });
      expect(result.written).toBe(true);
      expect(introspector.calls()).toBe(2);
      const saved = fs.read(credentialsPath(ROOT)) as string;
      expect(saved).toContain('GITHUB_OWNER=acme');
      expect(saved).toContain('GITHUB_REPO=widgets');
      // An empty answer keeps the value that was there — a token is not something to retype.
      expect(saved).toContain('GITHUB_TOKEN=old');
      expect(prompter.notes.join('\n')).toContain("Could not read 'github': HTTP 404");
      // A current value is shown as `[value]` next to the prompt so a typo is visible; a secret
      // never is, in a note or anywhere else.
      expect(prompter.notes.join('\n')).not.toContain('[old]');
    });

    it('names the file and the keys, and stops, when nobody can answer (--force)', async () => {
      const fs = memoryFileSystem();
      const failing = {
        async introspect(): Promise<never> {
          throw new Error('HTTP 401');
        },
      };
      await expect(
        runInit({
          root: ROOT,
          issuesProvider: 'github',
          fs,
          env: GH_ENV,
          prompter: scriptedPrompter([]),
          introspector: failing,
          force: true,
        }),
      ).rejects.toMatchObject({
        code: 'INTROSPECTION_FAILED',
        message: expect.stringMatching(/HTTP 401.*\.baron\/credentials.*GITHUB_TOKEN/s),
      });
    });

    it('stops with the same hint when re-entry is declined', async () => {
      const fs = memoryFileSystem();
      const failing = {
        async introspect(): Promise<never> {
          throw new Error('HTTP 401');
        },
      };
      await expect(
        runInit({
          root: ROOT,
          issuesProvider: 'github',
          fs,
          env: GH_ENV,
          prompter: scriptedPrompter([false]),
          introspector: failing,
        }),
      ).rejects.toMatchObject({ code: 'INTROSPECTION_FAILED' });
      expect(fs.read(policyPath(ROOT))).toBeUndefined();
    });
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

describe('the order init reports what it did', () => {
  it("finishes the caller's post-write work before printing the closing advice", async () => {
    // The CLI provisions the provider's workflow labels after the policy exists, and used to do it
    // AFTER runInit had already said "Next steps" — so the first thing a new user ever sees ended
    // with the closing advice and then carried on working. A callback rather than a second block of
    // output in the caller: the ordering is then guaranteed by construction, not by remembering.
    const prompter = scriptedPrompter([true]);
    let notesWhenCalled = -1;
    const result = await runInit({
      root: ROOT,
      issuesProvider: 'github',
      fs: memoryFileSystem(),
      env: GH_ENV,
      prompter,
      introspector: createMemoryIntrospector(githubIntrospectionFixture),
      afterWrite: async () => {
        notesWhenCalled = prompter.notes.length;
      },
    });

    const closing = prompter.notes.findIndex((note) => note.startsWith('Next steps'));
    expect(closing, 'no closing advice was printed at all').toBeGreaterThan(-1);
    expect(notesWhenCalled, 'the closing advice went out first').toBeGreaterThan(-1);
    expect(notesWhenCalled, "the closing advice preceded the caller's work").toBeLessThanOrEqual(
      closing,
    );
    // One announcement of one fact. It used to be said twice, in two wordings and two path styles,
    // because the caller repeated it with an absolute path.
    const wrote = prompter.notes.filter((note) => note.includes('Wrote '));
    expect(wrote).toHaveLength(1);
    expect(wrote[0]).toContain(result.policyPath);
  });
});

describe('an issues provider that has no source control of its own', () => {
  /** Linear's keys plus GitHub's, so nothing is prompted and the confirms below stay in order. */
  const MIXED_ENV = {
    LINEAR_API_KEY: 't',
    LINEAR_TEAM: 'ALPHA',
    GITHUB_OWNER: 'o',
    GITHUB_REPO: 'r',
    GITHUB_TOKEN: 't',
  };
  const remote = (url: string) => `[remote "origin"]\n\turl = ${url}\n`;

  it('offers to bind scm to the GitHub repo the git remote already names', async () => {
    // Baron binds scm to the issues provider when it ships one. Linear does not, so init wrote
    // `providers: { issues: 'linear' }` and stopped — and the first thing a new user runs,
    // task-start, died on scm.branch.create. Hand-editing policy.json was mandatory for the one
    // provider that can never avoid it by itself.
    const fs = memoryFileSystem({
      [gitConfigPath(ROOT)]: remote('https://github.com/acme/widgets.git'),
    });
    await runInit({
      root: ROOT,
      issuesProvider: 'linear',
      fs,
      env: MIXED_ENV,
      prompter: scriptedPrompter([true, true]),
      introspector: createMemoryIntrospector(scopedIntrospectionFixture),
    });

    const policy = parsePolicy(JSON.parse(fs.read(policyPath(ROOT)) as string));
    expect(policy.providers.issues).toBe('linear');
    expect(policy.providers.scm, 'the install still needs policy.json edited by hand').toBe(
      'github',
    );
  });

  it('leaves scm unbound rather than guessing at a remote it does not adapt', async () => {
    const fs = memoryFileSystem({
      [gitConfigPath(ROOT)]: remote('https://gitlab.com/acme/widgets.git'),
    });
    await runInit({
      root: ROOT,
      issuesProvider: 'linear',
      fs,
      env: MIXED_ENV,
      prompter: scriptedPrompter([true, true]),
      introspector: createMemoryIntrospector(scopedIntrospectionFixture),
    });

    const policy = parsePolicy(JSON.parse(fs.read(policyPath(ROOT)) as string));
    expect(policy.providers.scm).toBeUndefined();
  });

  it('does not offer when the user declines', async () => {
    const fs = memoryFileSystem({
      [gitConfigPath(ROOT)]: remote('git@github.com:acme/widgets.git'),
    });
    await runInit({
      root: ROOT,
      issuesProvider: 'linear',
      fs,
      env: MIXED_ENV,
      prompter: scriptedPrompter([false, true]),
      introspector: createMemoryIntrospector(scopedIntrospectionFixture),
    });

    const policy = parsePolicy(JSON.parse(fs.read(policyPath(ROOT)) as string));
    expect(policy.providers.scm).toBeUndefined();
  });
});

describe('what init shows before it replaces a policy', () => {
  it('names what changes and what it would drop, and changes nothing when declined', async () => {
    // Upgrading used to be blind: the overwrite question came before the proposal existed, and on
    // "no" init introspected anyway, built the proposal and threw it away. So the one question an
    // upgrade turns on could only be answered by agreeing to replace the file being protected.
    const fs = memoryFileSystem();
    await runInit({
      root: ROOT,
      issuesProvider: 'github',
      fs,
      env: GH_ENV,
      prompter: scriptedPrompter([true]),
      introspector: createMemoryIntrospector(githubIntrospectionFixture),
    });

    // Give this policy something to lose. The scope is the deterministic part: a GitHub proposal
    // never produces one, so it can only ever be dropped — which is the case worth being loud about.
    const onDisk = JSON.parse(fs.read(policyPath(ROOT)) as string);
    onDisk.typeMap.github.task = 'chore';
    onDisk.roleMap.github.scopes = { TEAM: { done: { label: 'shipped' } } };
    fs.write(policyPath(ROOT), JSON.stringify(onDisk, null, 2));

    const prompter = scriptedPrompter([false]);
    const result = await runInit({
      root: ROOT,
      issuesProvider: 'github',
      fs,
      env: GH_ENV,
      prompter,
      introspector: createMemoryIntrospector(githubIntrospectionFixture),
    });

    const shown = prompter.notes.join('\n');
    expect(shown).toContain('Against the policy already here');
    expect(shown, 'a changed mapping went unmentioned').toContain('chore');
    expect(shown, 'a mapping about to be lost went unmentioned').toContain('DROPS');
    expect(shown).toContain('TEAM');

    expect(result.written).toBe(false);
    const after = JSON.parse(fs.read(policyPath(ROOT)) as string);
    expect(after.typeMap.github.task, 'declining still rewrote the file').toBe('chore');
  });

  it('says the policy is unreadable rather than printing an empty diff', async () => {
    // An empty diff reads as "these two agree". Only one of them was understood.
    const fs = memoryFileSystem({ [policyPath(ROOT)]: '{ not json' });
    const prompter = scriptedPrompter([false]);
    await runInit({
      root: ROOT,
      issuesProvider: 'github',
      fs,
      env: GH_ENV,
      prompter,
      introspector: createMemoryIntrospector(githubIntrospectionFixture),
    });
    const shown = prompter.notes.join('\n');
    expect(shown).toContain('could not be parsed');
    expect(shown).toContain('replaced');
  });
});

describe('where the steering block goes', () => {
  const run = (fs: ReturnType<typeof memoryFileSystem>, answers: boolean[]) =>
    runInit({
      root: ROOT,
      issuesProvider: 'github',
      fs,
      env: GH_ENV,
      prompter: scriptedPrompter(answers),
      introspector: createMemoryIntrospector(githubIntrospectionFixture),
    });
  const AGENTS = `${ROOT}/AGENTS.md`;
  const CLAUDE = `${ROOT}/CLAUDE.md`;
  const MARKER = 'baron:begin';

  it('goes into CLAUDE.md when that is the file the project keeps', async () => {
    // AGENTS.md was written unconditionally, so a CLAUDE.md project got a SECOND steering document
    // instead of a refreshed one — and the stale one is the one the harness loads by name.
    const fs = memoryFileSystem({ [CLAUDE]: '# Project notes\n' });
    await run(fs, [true, true]);
    expect(fs.read(CLAUDE)).toContain(MARKER);
    expect(fs.exists(AGENTS), 'init created a competing steering file').toBe(false);
    expect(fs.read(CLAUDE), "the project's own notes were dropped").toContain('# Project notes');
  });

  it('prefers AGENTS.md when the project keeps both', async () => {
    const fs = memoryFileSystem({ [AGENTS]: '# Agents\n', [CLAUDE]: '# Claude\n' });
    await run(fs, [true, true]);
    expect(fs.read(AGENTS)).toContain(MARKER);
    expect(fs.read(CLAUDE)).not.toContain(MARKER);
  });

  it('refreshes the block where it already is, not where it would have gone', async () => {
    // The case that produces two: a block living in CLAUDE.md while an unrelated AGENTS.md exists.
    const fs = memoryFileSystem({
      [AGENTS]: '# Unrelated\n',
      [CLAUDE]:
        '# Claude\n\n<!-- baron:begin — managed by `baron init`; edit outside these markers -->\nstale\n<!-- baron:end -->\n',
    });
    await run(fs, [true, true]);
    expect(fs.read(CLAUDE)).toContain('Work tracking — route through Baron');
    expect(fs.read(CLAUDE), 'the old block was left beside the new one').not.toContain('stale');
    expect(fs.read(AGENTS)).not.toContain(MARKER);
  });

  it('creates AGENTS.md when the project keeps neither', async () => {
    const fs = memoryFileSystem();
    await run(fs, [true, true]);
    expect(fs.read(AGENTS)).toContain(MARKER);
    expect(fs.exists(CLAUDE)).toBe(false);
  });
});
