import { describe, expect, it } from 'vitest';
import { type CliPorts, runCli } from './cli.js';
import { memoryFileSystem, scriptedPrompter } from './fakes.js';

function harness(seed: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const ports: CliPorts = {
    fs: memoryFileSystem(seed),
    prompter: scriptedPrompter([true]),
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

  it('exits 1 on an unknown command', async () => {
    const { ports, err } = harness();
    expect(await runCli(['frobnicate'], ports)).toBe(1);
    expect(err.join('\n')).toContain("Unknown command 'frobnicate'");
  });

  it('exits 2 when init is missing --provider', async () => {
    const { ports, err } = harness();
    expect(await runCli(['init'], ports)).toBe(2);
    expect(err.join('\n')).toContain('--provider');
  });

  it('surfaces a BaronError as a non-zero exit with the error code', async () => {
    // The live introspector is a NOT_IMPLEMENTED stub, so a real init fails loudly (never silent).
    const { ports, err } = harness();
    expect(await runCli(['init', '--provider', 'github'], ports)).toBe(1);
    expect(err.join('\n')).toContain('NOT_IMPLEMENTED');
  });

  it('exits 1 on an unknown provider', async () => {
    const { ports, err } = harness();
    expect(await runCli(['init', '--provider', 'jira'], ports)).toBe(1);
    expect(err.join('\n')).toContain('UNKNOWN_PROVIDER');
  });

  it('doctor exits 1 with an actionable error when no policy exists', async () => {
    const { ports, err } = harness();
    expect(await runCli(['doctor'], ports)).toBe(1);
    expect(err.join('\n')).toContain('POLICY_NOT_FOUND');
  });
});
