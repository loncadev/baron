import {
  BaronError,
  parsePolicyJson,
  resolveIssuesConfig,
  roleLabelSpecs,
} from '@lonca/baron-core';
import {
  type Env,
  KNOWN_PROVIDERS,
  buildIssuesPort,
  credentialsPath,
  mergeCredentials,
} from '@lonca/baron-providers';
import type { RecipeAsker } from '@lonca/baron-recipes';
import { runDoctor } from './doctor.js';
import { runInit } from './init.js';
import { policyPath } from './paths.js';
import type { FileSystem, Prompter } from './ports.js';
import { runRecipeFile } from './run.js';

export interface CliPorts {
  readonly fs: FileSystem;
  readonly prompter: Prompter;
  /** Typed prompter for `run` recipe `ask` steps. */
  readonly asker: RecipeAsker;
  readonly env: Env;
  out(message: string): void;
  err(message: string): void;
}

const USAGE = `baron — platform-agnostic work-orchestration

Usage:
  baron init --provider <id> [--root <dir>] [--force]
  baron doctor [--root <dir>]
  baron run --recipe <path> [--root <dir>]

Commands:
  init     Introspect a provider, propose a role/type/gap map, confirm, and write .baron/policy.json
  doctor   Validate .baron/policy.json against the live provider and report drift
  run      Execute a YAML recipe against the policy's live ports

Providers: ${KNOWN_PROVIDERS.join(', ')}`;

/**
 * The brand banner shown at the top of every run. Printed to STDERR so it never pollutes stdout
 * (recipe output / anything a script might parse), and suppressed by BARON_NO_BANNER for CI quiet.
 */
const BANNER = `
  ██████    █████   ██████    █████   ██   ██
  ██   ██  ██   ██  ██   ██  ██   ██  ███  ██
  ██████   ███████  ██████   ██   ██  ██ █ ██
  ██   ██  ██   ██  ██  ██   ██   ██  ██  ███
  ██████   ██   ██  ██   ██   █████   ██   ██

  work-orchestration for AI coding agents · by Lonca
`;

function printBanner(ports: CliPorts): void {
  if (ports.env.BARON_NO_BANNER !== undefined && ports.env.BARON_NO_BANNER !== '') return;
  ports.err(BANNER);
}

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

/** Overlay the gitignored `.baron/credentials` file (if any) onto the process env for this root. */
function effectiveEnv(ports: CliPorts, root: string): Env {
  return mergeCredentials(ports.env, ports.fs.read(credentialsPath(root)));
}

async function cmdInit(flags: Record<string, string>, ports: CliPorts): Promise<number> {
  const issuesProvider = flags.provider;
  if (issuesProvider === undefined) {
    ports.err('init requires --provider <id>.');
    ports.err(USAGE);
    return 2;
  }
  const root = flags.root ?? '.';
  const result = await runInit({
    root,
    issuesProvider,
    fs: ports.fs,
    prompter: ports.prompter,
    env: effectiveEnv(ports, root),
    force: flags.force === 'true',
  });
  if (!result.written) {
    ports.out('Aborted; no changes written.');
    return 0;
  }
  ports.out(`Wrote ${result.policyPath}.`);
  await provisionRoleLabels(ports, root);
  return 0;
}

/**
 * After init writes the policy, provision the provider's workflow labels so a transition never
 * depends on a provider silently auto-creating a grey one. A no-op for native-state providers
 * (roleLabelSpecs is empty). Best-effort: a failure here doesn't undo a valid setup — the labels
 * would just be auto-created on first use — so it warns rather than failing the command.
 */
async function provisionRoleLabels(ports: CliPorts, root: string): Promise<void> {
  const raw = ports.fs.read(policyPath(root));
  if (raw === undefined) return;
  const config = resolveIssuesConfig(parsePolicyJson(raw));
  const specs = roleLabelSpecs(config.roleMap);
  if (specs.length === 0) return;
  try {
    await buildIssuesPort(config, effectiveEnv(ports, root)).ensureLabels(specs);
    ports.out(
      `Provisioned ${specs.length} workflow labels: ${specs.map((s) => s.name).join(', ')}.`,
    );
  } catch (error) {
    ports.err(
      `note: could not provision workflow labels now (${
        error instanceof Error ? error.message : String(error)
      }); they'll be created on first use.`,
    );
  }
}

async function cmdDoctor(flags: Record<string, string>, ports: CliPorts): Promise<number> {
  const root = flags.root ?? '.';
  const report = await runDoctor({ root, fs: ports.fs, env: effectiveEnv(ports, root) });
  if (report.ok) {
    ports.out(`OK — ${report.checks} reference(s) checked for '${report.provider}', no drift.`);
    return 0;
  }
  ports.err(`Drift detected for '${report.provider}' (${report.drift.length}):`);
  for (const item of report.drift) ports.err(`  - ${item}`);
  return 1;
}

async function cmdRun(flags: Record<string, string>, ports: CliPorts): Promise<number> {
  const recipePath = flags.recipe;
  if (recipePath === undefined) {
    ports.err('run requires --recipe <path>.');
    ports.err(USAGE);
    return 2;
  }
  const root = flags.root ?? '.';
  await runRecipeFile({
    root,
    recipePath,
    fs: ports.fs,
    asker: ports.asker,
    env: effectiveEnv(ports, root),
  });
  ports.out(`Recipe ${recipePath} finished.`);
  return 0;
}

/**
 * Parse argv and dispatch a command, returning a process exit code. All side effects flow through
 * the injected {@link CliPorts}, so the whole CLI is testable without a real terminal. The shell in
 * `bin.ts` wires the Node-backed ports and translates the return value into `process.exit`.
 */
export async function runCli(argv: readonly string[], ports: CliPorts): Promise<number> {
  const [command, ...rest] = argv;
  const { flags } = parseFlags(rest);

  printBanner(ports);

  try {
    switch (command) {
      case 'init':
        return await cmdInit(flags, ports);
      case 'doctor':
        return await cmdDoctor(flags, ports);
      case 'run':
        return await cmdRun(flags, ports);
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
    // Catch-all so a live provider failure (auth/network) surfaces as a clean non-zero exit rather
    // than a raw stack trace; BaronErrors additionally carry an actionable code.
    if (error instanceof BaronError) {
      ports.err(`error [${error.code}]: ${error.message}`);
    } else {
      ports.err(`error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 1;
  }
}
