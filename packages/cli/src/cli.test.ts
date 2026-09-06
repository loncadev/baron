import { describe, expect, it } from 'vitest';
import { type CliPorts, runCli } from './cli.js';
import { memoryFileSystem, scriptedAsker, scriptedPrompter } from './fakes.js';
import { policyPath } from './paths.js';

function harness(seed: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const ports: CliPorts = {
    fs: memoryFileSystem(seed),
    prompter: scriptedPrompter([true]),
    asker: scriptedAsker(),
    env: {},
    out: (m) => out.push(m),
    err: (m) => err.push(m),
  };
  return { ports, out, err };
}

describe('runCli', () => {
  it('prints usage and exits 0 with no command', async () => {
    const { ports, out } = harness();
    expect(await runCli([], ports)).toBe(0);
    expect(out.join('\n')).toContain('Usage:');
  });

  it('prints the brand banner to stderr (not stdout), suppressible via BARON_NO_BANNER', async () => {
    const shown = harness();
    await runCli([], shown.ports);
    // Banner is chrome: it goes to stderr so stdout stays clean for data/recipe output.
    expect(shown.err.join('\n')).toContain('by Lonca');
    expect(shown.out.join('\n')).not.toContain('by Lonca');

    const quiet = harness();
    quiet.ports.env.BARON_NO_BANNER = '1';
    await runCli([], quiet.ports);
    expect(quiet.err.join('\n')).not.toContain('by Lonca');
  });

  it('exits 1 on an unknown command', async () => {
    const { ports, err } = harness();
    expect(await runCli(['frobnicate'], ports)).toBe(1);
    expect(err.join('\n')).toContain("Unknown command 'frobnicate'");
  });

  it('prompts for the provider (not a usage error) when init omits --provider', async () => {
    // Missing --provider no longer exits 2: init asks. Here the default provider is chosen, then the
    // run fails later on absent credentials (exit 1) — proving it proceeded past provider selection.
    const { ports, err } = harness();
    const code = await runCli(['init'], ports);
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('CREDENTIALS_MISSING');
  });

  it('surfaces a BaronError as a non-zero exit with the error code', async () => {
    // A malformed (but valid-JSON) policy fails validation with an actionable, coded BaronError —
    // an offline, deterministic way to prove the error surface (no live provider call).
    const { ports, err } = harness({ [policyPath('/repo')]: '{"version":2}' });
    expect(await runCli(['doctor', '--root', '/repo'], ports)).toBe(1);
    expect(err.join('\n')).toContain('POLICY_PARSE');
  });

  it('exits 1 on an unknown provider', async () => {
    const { ports, err } = harness();
    expect(await runCli(['init', '--provider', 'asana'], ports)).toBe(1);
    expect(err.join('\n')).toContain('UNKNOWN_PROVIDER');
  });

  it('doctor exits 1 with an actionable error when no policy exists', async () => {
    const { ports, err } = harness();
    expect(await runCli(['doctor'], ports)).toBe(1);
    expect(err.join('\n')).toContain('POLICY_NOT_FOUND');
  });

  it('exits 2 when run is missing --recipe', async () => {
    const { ports, err } = harness();
    expect(await runCli(['run'], ports)).toBe(2);
    expect(err.join('\n')).toContain('--recipe');
  });
});

describe('--help on a subcommand', () => {
  // `--help` was matched only as a COMMAND, so it fell through the switch into the command itself.
  // `baron init --help` therefore ran the wizard — asking which provider hosts your work items, then
  // offering to overwrite .baron/policy.json and to hand over a token. Reading the help is the one
  // gesture a user makes precisely because they do not want to run the thing yet.
  for (const flag of ['--help', '-h']) {
    it(`prints usage and changes nothing for init ${flag}`, async () => {
      const { ports, out, err } = harness();
      expect(await runCli(['init', flag], ports)).toBe(0);
      expect(out.join('\n')).toContain('Usage:');
      expect(err.join('\n'), 'the wizard announced itself').not.toContain('baron init —');
      expect(ports.fs.exists(policyPath('.')), 'init --help wrote a policy').toBe(false);
    });
  }

  it('prints usage for run --help without reporting a missing recipe', async () => {
    const { ports, out, err } = harness();
    // It used to "work" by accident: no --recipe, so it failed, and the failure path prints usage.
    // Exit 2 for asking a question is the tell.
    expect(await runCli(['run', '--help'], ports)).toBe(0);
    expect(out.join('\n')).toContain('Usage:');
    expect(err.join('\n')).not.toContain('requires --recipe');
  });

  it('says a recipe may be named, not only pathed', async () => {
    // `--recipe <path>` outlived the truth: built-in recipes have been accepted by NAME since #95,
    // so the usage sent a user hunting for a YAML file that ships inside the package.
    const { ports, out } = harness();
    await runCli(['--help'], ports);
    expect(out.join('\n')).toContain('--recipe <name-or-path>');
  });
});

describe('baron run reports the run id and how to resume', () => {
  const policy =
    '{"version":1,"providers":{"issues":"github"},"roleMap":{"github":{"stateKey":"label","states":{"done":{"state":"closed","label":"done"}}}},"typeMap":{"github":{"task":"issue"}}}';
  const recipe =
    'name: half\nsteps:\n  - message: "before"\n  - do: notify.send\n    with: { text: "x" }\n';

  it('prints the exact --resume command when a run stops, and exits 1', async () => {
    const { ports, err } = harness({ [policyPath('/repo')]: policy, '/repo/r.yaml': recipe });
    ports.env.GITHUB_OWNER = 'o';
    ports.env.GITHUB_REPO = 'r';
    ports.env.GITHUB_TOKEN = 't';
    expect(await runCli(['run', '--recipe', '/repo/r.yaml', '--root', '/repo'], ports)).toBe(1);
    const text = err.join('\n');
    expect(text).toContain('PORT_UNBOUND');
    expect(text).toMatch(/Run [a-z0-9]+-[0-9a-f]{8} stopped at step notify\.send/);
    expect(text).toMatch(/baron run --resume [a-z0-9]+-[0-9a-f]{8} --root \/repo/);
  });

  it('accepts --resume without --recipe, and neither is a usage error', async () => {
    const { ports, err } = harness({ [policyPath('/repo')]: policy });
    expect(await runCli(['run', '--root', '/repo'], ports)).toBe(2);
    expect(err.join('\n')).toContain('--resume');
    // A resume of a run nobody journaled is a coded error, not a usage error.
    expect(await runCli(['run', '--resume', 'ghost', '--root', '/repo'], ports)).toBe(1);
    expect(err.join('\n')).toContain('RUN_NOT_FOUND');
  });
});
