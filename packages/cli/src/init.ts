import {
  BaronError,
  type BaronPolicyFile,
  type Introspector,
  type ProviderProposal,
  parsePolicy,
  proposePolicy,
  serializePolicy,
} from '@lonca/baron-core';
import { type Env, type ProviderDescriptor, getProviderDescriptor } from '@lonca/baron-providers';
import {
  BARON_DIR,
  CREDENTIALS_IGNORE_ENTRY,
  credentialsExamplePath,
  gitignorePath,
  policyPath,
} from './paths.js';
import type { FileSystem, Prompter } from './ports.js';

export interface InitOptions {
  readonly root: string;
  /** Provider to bind to the issues port. */
  readonly issuesProvider: string;
  readonly fs: FileSystem;
  readonly prompter: Prompter;
  /** Injected introspector (tests). When absent, built from the registry + env credentials. */
  readonly introspector?: Introspector;
  readonly env?: Env;
  /** Overwrite an existing policy without confirming. */
  readonly force?: boolean;
}

export interface InitResult {
  readonly written: boolean;
  readonly policyPath: string;
  readonly proposal: ProviderProposal;
}

/**
 * Assemble a policy from a proposal. Binds the provider to `issues`, and to `scm` too when it offers
 * a source-control adapter (`bindScm`) — the task-start/finish flow needs branches + PRs, and making
 * every user hand-add `providers.scm` after init was a dead-end the from-scratch setup kept hitting.
 * A mixed setup (issues here, scm elsewhere) is still possible by editing the file. The gap policy is
 * only emitted when the provider actually has gaps, so a fully-capable provider produces a clean file.
 */
export function assemblePolicy(
  proposal: ProviderProposal,
  opts: { bindScm?: boolean } = {},
): BaronPolicyFile {
  const hasGaps = Object.keys(proposal.gapPolicy).length > 0;
  const object = {
    version: 1 as const,
    providers: {
      issues: proposal.provider,
      ...(opts.bindScm === true ? { scm: proposal.provider } : {}),
    },
    roleMap: { [proposal.provider]: proposal.roleMap },
    typeMap: { [proposal.provider]: proposal.typeMap },
    ...(hasGaps ? { gapPolicy: { [proposal.provider]: proposal.gapPolicy } } : {}),
  };
  // Round-trip through the loader so init can never emit a policy the loader would later reject.
  return parsePolicy(JSON.parse(JSON.stringify(object)));
}

function credentialsTemplate(descriptor: ProviderDescriptor): string {
  const header = `# Credentials for '${descriptor.id}'. Copy this file to '${BARON_DIR}/credentials'\n# (gitignored) or export these in your environment. Never commit real values.\n`;
  // Union of the issues + scm credential keys (deduped), so a policy that binds both ports lists
  // every variable the user must fill — e.g. Azure's scm adds AZURE_DEVOPS_REPO over the issues set.
  const keys = [
    ...new Set([
      ...(descriptor.credentialEnvKeys ?? []),
      ...(descriptor.scmCredentialEnvKeys ?? []),
    ]),
  ];
  const lines = keys.map((key) => `${key}=`).join('\n');
  return `${header}${lines}\n`;
}

/** Scaffold a credentials template (if absent) and ensure the real credentials file is gitignored. */
function scaffoldCredentials(fs: FileSystem, root: string, descriptor: ProviderDescriptor): void {
  const examplePath = credentialsExamplePath(root);
  if (!fs.exists(examplePath)) {
    fs.write(examplePath, credentialsTemplate(descriptor));
  }

  const ignorePath = gitignorePath(root);
  const current = fs.read(ignorePath) ?? '';
  const lines = current.split('\n').map((l) => l.trim());
  if (!lines.includes(CREDENTIALS_IGNORE_ENTRY)) {
    const prefix = current.length === 0 || current.endsWith('\n') ? current : `${current}\n`;
    fs.write(ignorePath, `${prefix}${CREDENTIALS_IGNORE_ENTRY}\n`);
  }
}

function summarizeProposal(prompter: Prompter, proposal: ProviderProposal, bindScm: boolean): void {
  const ports = bindScm ? 'issues + scm (branches/PRs)' : 'issues';
  prompter.note(`Binding provider '${proposal.provider}' to: ${ports}.`);
  prompter.note(`Proposed mapping for issues provider '${proposal.provider}':`);
  for (const [role, target] of Object.entries(proposal.roleMap.states)) {
    prompter.note(`  role ${role} -> ${JSON.stringify(target)}`);
  }
  for (const [typeRole, native] of Object.entries(proposal.typeMap)) {
    prompter.note(`  type ${typeRole} -> ${native}`);
  }
  for (const [capability, behavior] of Object.entries(proposal.gapPolicy)) {
    prompter.note(`  gap ${capability} -> ${behavior}`);
  }
  if (proposal.notes.length > 0) {
    prompter.note('Notes (confirm these guesses):');
    for (const note of proposal.notes) prompter.note(`  - ${note}`);
  }
}

/**
 * `baron init`: introspect the issues provider, propose a role/type/gap mapping, let a human confirm
 * it, then write `.baron/policy.json` (committed) and scaffold credentials (gitignored). All I/O
 * goes through injected ports so the flow is exercised end-to-end without touching a real disk or
 * network in tests.
 */
export async function runInit(options: InitOptions): Promise<InitResult> {
  const descriptor = getProviderDescriptor(options.issuesProvider);
  const { createIntrospector, manifest } = descriptor;
  if (createIntrospector === undefined || manifest === undefined) {
    throw new BaronError(
      `Provider '${options.issuesProvider}' has no issues adapter to initialize.`,
      'ISSUES_UNSUPPORTED',
    );
  }
  const path = policyPath(options.root);

  if (options.fs.exists(path) && options.force !== true) {
    const overwrite = await options.prompter.confirm(
      `${path} already exists. Overwrite it?`,
      false,
    );
    if (!overwrite) {
      const introspection = await (
        options.introspector ?? createIntrospector(options.env ?? {})
      ).introspect();
      return {
        written: false,
        policyPath: path,
        proposal: proposePolicy(introspection, manifest),
      };
    }
  }

  const introspector = options.introspector ?? createIntrospector(options.env ?? {});
  const introspection = await introspector.introspect();
  const proposal = proposePolicy(introspection, manifest);

  // Bind scm to the same provider when it ships an scm adapter — the task-start/finish flow needs it.
  const bindScm =
    descriptor.scmManifest !== undefined && descriptor.createScmTransport !== undefined;

  summarizeProposal(options.prompter, proposal, bindScm);

  const confirmed =
    options.force === true ||
    (await options.prompter.confirm(`Write ${path} with this mapping?`, true));
  if (!confirmed) {
    return { written: false, policyPath: path, proposal };
  }

  const policy = assemblePolicy(proposal, { bindScm });
  options.fs.mkdirp(`${options.root}/${BARON_DIR}`);
  options.fs.write(path, serializePolicy(policy));
  scaffoldCredentials(options.fs, options.root, descriptor);

  return { written: true, policyPath: path, proposal };
}
