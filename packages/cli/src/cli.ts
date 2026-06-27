import { BaronError } from '@baron/core';
import { runDoctor } from './doctor.js';
import { runInit } from './init.js';
import type { FileSystem, Prompter } from './ports.js';
import { KNOWN_PROVIDERS } from './registry.js';
import type { Env } from './registry.js';

export interface CliPorts {
  readonly fs: FileSystem;
  readonly prompter: Prompter;
  readonly env: Env;
  out(message: string): void;
  err(message: string): void;
}

const USAGE = `baron — work-orchestration config engine

Usage:
  baron init --provider <id> [--root <dir>] [--force]
  baron doctor [--root <dir>]

Commands:
  init     Introspect a provider, propose a role/type/gap map, confirm, and write .baron/policy.json
  doctor   Validate .baron/policy.json against the live provider and report drift

Providers: ${KNOWN_PROVIDERS.join(', ')}`;

/** Minimal, dependency-free flag parser: `--key value` pairs and bare `--flag` booleans. */
function parseFlags(args: readonly string[]): {
  flags: Record<string, string>;
  positionals: string[];
} {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === undefined) continue;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = 'true';
      }
    } else {
      positionals.push(token);
    }
  }
  return { flags, positionals };
}

async function cmdInit(flags: Record<string, string>, ports: CliPorts): Promise<number> {
  const issuesProvider = flags.provider;
  if (issuesProvider === undefined) {
    ports.err('init requires --provider <id>.');
    ports.err(USAGE);
    return 2;
  }
  const result = await runInit({
    root: flags.root ?? '.',
    issuesProvider,
    fs: ports.fs,
    prompter: ports.prompter,
    env: ports.env,
    force: flags.force === 'true',
  });
  if (result.written) {
    ports.out(`Wrote ${result.policyPath}.`);
  } else {
    ports.out('Aborted; no changes written.');
  }
  return 0;
}

async function cmdDoctor(flags: Record<string, string>, ports: CliPorts): Promise<number> {
  const report = await runDoctor({ root: flags.root ?? '.', fs: ports.fs, env: ports.env });
  if (report.ok) {
    ports.out(`OK — ${report.checks} reference(s) checked for '${report.provider}', no drift.`);
    return 0;
  }
  ports.err(`Drift detected for '${report.provider}' (${report.drift.length}):`);
  for (const item of report.drift) ports.err(`  - ${item}`);
  return 1;
}

/**
 * Parse argv and dispatch a command, returning a process exit code. All side effects flow through
 * the injected {@link CliPorts}, so the whole CLI is testable without a real terminal. The shell in
 * `bin.ts` wires the Node-backed ports and translates the return value into `process.exit`.
 */
export async function runCli(argv: readonly string[], ports: CliPorts): Promise<number> {
  const [command, ...rest] = argv;
  const { flags } = parseFlags(rest);

  try {
    switch (command) {
      case 'init':
        return await cmdInit(flags, ports);
      case 'doctor':
        return await cmdDoctor(flags, ports);
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        ports.out(USAGE);
        return 0;
      default:
        ports.err(`Unknown command '${command}'.`);
        ports.err(USAGE);
        return 1;
    }
  } catch (error) {
    if (error instanceof BaronError) {
      ports.err(`error [${error.code}]: ${error.message}`);
      return 1;
    }
    throw error;
  }
}
