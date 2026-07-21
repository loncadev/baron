import {
  BaronError,
  type BaronPolicyFile,
  type Introspector,
  type ProviderProposal,
  parsePolicy,
  proposePolicy,
  serializePolicy,
} from '@lonca/baron-core';
import {
  type Env,
  type ProviderDescriptor,
  getProviderDescriptor,
  mergeCredentials,
  parseCredentials,
} from '@lonca/baron-providers';
import {
  BARON_DIR,
  CREDENTIALS_IGNORE_ENTRY,
  credentialsExamplePath,
  credentialsPath,
  gitConfigPath,
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

/** Add the credentials file to .gitignore if it isn't already — a secret must never be committed. */
function ensureGitignored(fs: FileSystem, root: string): void {
  const ignorePath = gitignorePath(root);
  const current = fs.read(ignorePath) ?? '';
  const lines = current.split('\n').map((l) => l.trim());
  if (!lines.includes(CREDENTIALS_IGNORE_ENTRY)) {
    const prefix = current.length === 0 || current.endsWith('\n') ? current : `${current}\n`;
    fs.write(ignorePath, `${prefix}${CREDENTIALS_IGNORE_ENTRY}\n`);
  }
}

/** Scaffold a credentials template (if absent) and ensure the real credentials file is gitignored. */
function scaffoldCredentials(fs: FileSystem, root: string, descriptor: ProviderDescriptor): void {
  const examplePath = credentialsExamplePath(root);
  if (!fs.exists(examplePath)) {
    fs.write(examplePath, credentialsTemplate(descriptor));
  }
  ensureGitignored(fs, root);
}

/** Credential keys that hold a secret and must be entered hidden (never echoed to the terminal). */
const SECRET_KEY = /TOKEN|SECRET|PASSWORD|PAT|API[_-]?KEY/i;

/**
 * Best-effort owner/repo from a repo's `.git/config` origin remote, so a GitHub setup doesn't have
 * to retype what git already knows. Handles both `https://github.com/owner/repo(.git)` and
 * `git@github.com:owner/repo(.git)`. Keyed by the exact env-var names, so it's a no-op for any
 * provider that doesn't use them.
 */
function detectGitCoordinates(configText: string | undefined): Record<string, string> {
  if (configText === undefined) return {};
  const url = configText.match(/\[remote "origin"\][\s\S]*?url\s*=\s*(\S+)/)?.[1];
  const gh = url?.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
  return gh ? { GITHUB_OWNER: gh[1] as string, GITHUB_REPO: gh[2] as string } : {};
}

function writeCredentialsFile(
  fs: FileSystem,
  root: string,
  descriptor: ProviderDescriptor,
  values: Record<string, string>,
  orderedKeys: readonly string[],
): void {
  const header = `# Baron credentials for '${descriptor.id}' — gitignored, NEVER commit. Written by \`baron init\`.\n`;
  // Emit the required keys in order first, then any extras already in the file, so the layout is stable.
  const keys = [...orderedKeys, ...Object.keys(values).filter((k) => !orderedKeys.includes(k))];
  const body = keys.map((k) => `${k}=${values[k] ?? ''}`).join('\n');
  fs.write(credentialsPath(root), `${header}${body}\n`);
}

/**
 * Gather the provider's credentials so `baron init` is a single command instead of "hand-create
 * .baron/credentials, THEN run init". Keys already set (env or an existing file) are kept; GitHub
 * owner/repo are auto-detected from the git remote; the rest are prompted (secrets entered hidden).
 * The file is written (gitignored) and the effective env is returned for introspection. A key left
 * blank fails loudly rather than introspecting with an empty token.
 */
async function ensureCredentials(
  fs: FileSystem,
  prompter: Prompter,
  root: string,
  descriptor: ProviderDescriptor,
  env: Env,
): Promise<Env> {
  const required = [
    ...new Set([
      ...(descriptor.credentialEnvKeys ?? []),
      ...(descriptor.scmCredentialEnvKeys ?? []),
    ]),
  ];
  const existing = mergeCredentials(env, fs.read(credentialsPath(root)));
  const missing = required.filter((key) => {
    const v = existing[key];
    return v === undefined || v === '';
  });
  if (missing.length === 0) return existing;

  const detected = detectGitCoordinates(fs.read(gitConfigPath(root)));
  const fileValues: Record<string, string> = {
    ...(fs.read(credentialsPath(root)) !== undefined
      ? parseCredentials(fs.read(credentialsPath(root)) as string)
      : {}),
  };

  prompter.note(
    `\nSetting up credentials → ${CREDENTIALS_IGNORE_ENTRY} (gitignored, never committed).`,
  );
  // Show the provider's token guidance (where to get it, which permissions) — but only when a value
  // must actually be typed, so an all-autodetected run stays quiet.
  const willPrompt = missing.some((key) => detected[key] === undefined);
  if (willPrompt && descriptor.credentialsHelp !== undefined) {
    prompter.note('');
    for (const line of descriptor.credentialsHelp) prompter.note(line);
    prompter.note('');
  }

  for (const key of missing) {
    const auto = detected[key];
    if (auto !== undefined) {
      prompter.note(`  ${key} = ${auto}  (detected from your git remote)`);
      fileValues[key] = auto;
      continue;
    }
    const secret = SECRET_KEY.test(key);
    const answer = await prompter.text(
      `  ${key}${secret ? ' (paste the token — input hidden)' : ''}:`,
      { secret },
    );
    fileValues[key] = answer.trim();
  }

  // The .baron dir may not exist yet on a fresh project — create it before writing the credentials
  // file (the policy write later does its own mkdirp, but that runs after this).
  fs.mkdirp(`${root}/${BARON_DIR}`);
  writeCredentialsFile(fs, root, descriptor, fileValues, required);
  ensureGitignored(fs, root);
  prompter.note(`Saved ${CREDENTIALS_IGNORE_ENTRY} (gitignored — your token is not committed).`);

  const effective = mergeCredentials(env, fs.read(credentialsPath(root)));
  const stillMissing = required.filter((key) => {
    const v = effective[key];
    return v === undefined || v === '';
  });
  if (stillMissing.length > 0) {
    throw new BaronError(
      `Missing credential(s): ${stillMissing.join(', ')}. Fill them in ${CREDENTIALS_IGNORE_ENTRY} and re-run \`baron init\`.`,
      'CREDENTIALS_MISSING',
    );
  }
  return effective;
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

// A marker-delimited steering block so re-running init refreshes it in place rather than duplicating,
// and a human's edits outside the markers are never touched.
const STEERING_BEGIN = '<!-- baron:begin — managed by `baron init`; edit outside these markers -->';
const STEERING_END = '<!-- baron:end -->';

/** The provider facts that change how an agent should behave — derived from the manifest + role map,
 * so the steering's "on this provider" note is always accurate, never guessed. */
interface SteeringContext {
  readonly provider: string;
  /** Roles ride labels (GitHub) vs the provider's native states (Azure). */
  readonly rolesRideLabels: boolean;
  readonly sprints: boolean;
  readonly hierarchy: boolean;
}

/**
 * Agent steering: teaches an agent to drive work through Baron's abstract vocabulary, not raw
 * provider writes. Harness-neutral (AGENTS.md), so any agent that reads it benefits. The abstract
 * core is provider-independent; a short "on this provider" note (derived from the manifest) tells the
 * agent which capabilities exist here — so a degraded capability's empty result isn't mistaken for a
 * bug (the exact confusion a flat provider caused in dogfooding).
 */
function steeringBlock(ctx: SteeringContext): string {
  const roles = ctx.rolesRideLabels
    ? 'labels (Baron provisions `in-progress` / `in-review` / `done`)'
    : "the provider's native states";
  const sprints = ctx.sprints
    ? 'available (`baron_issue_iterations`, filter by `@current`)'
    : 'NOT available — sprint queries degrade to empty. That empty is expected here, not a bug';
  const hierarchy = ctx.hierarchy ? 'native parent/child' : 'emulated via a `parent:<id>` label';
  const body = `## Work tracking — route through Baron

Track work through **Baron**, not raw provider writes: it normalizes issues and source control across
providers behind one contract, so speak its abstract vocabulary, never a vendor's native states.

- **Roles, not native states.** Move work by role: \`backlog → ready → in_progress → in_review → done\`,
  plus \`blocked\`. Types are roles too: \`initiative\`, \`epic\`, \`story\`, \`task\`, \`bug\`, \`subtask\`.
  Say "move it to in_progress", never "set the state to Active" — Baron maps the role to the provider.
- **Tools:** \`baron_issue_*\` (create / get / update / transition / comment / assign / link / query),
  \`baron_scm_*\` (branch / PR), \`baron_recipe_run\`, and \`baron_learning_*\` / \`baron_followup_*\` for
  durable decisions and follow-ups.
- **Daily loop — prefer the skills:** \`/baron:task-new\` (create), \`/baron:task-start <id>\` (cut the
  canonical branch, move to in_progress, assign you), \`/baron:task-finish\` (draft PR), \`/baron:task-move\`,
  \`/baron:task-list\`, \`/baron:task-sync\`. Each item's canonical branch is Baron-derived — use it
  verbatim, never invent one.
- Reading/exploring a provider natively is fine, but make every work-item **change** through Baron so the
  role mapping, gap policy, and knowledge loop apply.

**On this project (provider: \`${ctx.provider}\`):** roles ride ${roles}; sprints are ${sprints};
parent/child is ${hierarchy}. Where a capability is missing Baron negotiates it (error / emulate /
degrade) and logs it — an empty or emulated result from a degraded capability is expected behavior,
not a silent failure to report as a bug.`;
  return `${STEERING_BEGIN}\n${body}\n${STEERING_END}`;
}

/**
 * Write (or refresh) the Baron steering block in AGENTS.md so an agent knows to drive work through
 * Baron. Idempotent: an existing marked block is replaced in place; anything outside the markers is
 * preserved; a fresh file is created. Asks first (it's the user's file) unless `force`. Returns
 * whether it wrote.
 */
async function ensureAgentsSteering(
  fs: FileSystem,
  prompter: Prompter,
  root: string,
  force: boolean,
  ctx: SteeringContext,
): Promise<boolean> {
  const path = `${root}/AGENTS.md`;
  const current = fs.read(path);
  const hasBlock = current?.includes(STEERING_BEGIN) === true && current.includes(STEERING_END);
  const verb =
    current === undefined
      ? 'Create'
      : hasBlock
        ? 'Refresh the Baron block in'
        : 'Add a Baron block to';
  const ok =
    force || (await prompter.confirm(`${verb} AGENTS.md (agent steering for Baron)?`, true));
  if (!ok) return false;

  const block = steeringBlock(ctx);
  let next: string;
  if (current === undefined) {
    next = `${block}\n`;
  } else if (hasBlock) {
    const start = current.indexOf(STEERING_BEGIN);
    const end = current.indexOf(STEERING_END) + STEERING_END.length;
    next = current.slice(0, start) + block + current.slice(end);
  } else {
    const sep = current.length === 0 || current.endsWith('\n') ? '\n' : '\n\n';
    next = `${current}${sep}${block}\n`;
  }
  fs.write(path, next);
  return true;
}

/** Up-front "here is exactly what I will do" so a first run earns trust before it touches anything. */
function announcePlan(prompter: Prompter, provider: string): void {
  prompter.note(`\nbaron init — configuring Baron for '${provider}' in this project. It will:`);
  prompter.note('  • detect what it can from your git remote, and ask for a provider token;');
  prompter.note(`  • write ${BARON_DIR}/credentials — your token, GITIGNORED, never committed;`);
  prompter.note(
    '  • introspect your provider and PROPOSE a role mapping — nothing is written until',
  );
  prompter.note('    you confirm it;');
  prompter.note(
    `  • write ${BARON_DIR}/policy.json — the confirmed mapping, COMMITTED (no secrets);`,
  );
  prompter.note('  • offer to add a Baron steering block to AGENTS.md (so an agent uses Baron).');
  prompter.note(
    'The only thing it creates on your provider is your workflow labels (GitHub); it never touches',
  );
  prompter.note('your existing issues or PRs, and never prints or commits your token.\n');
}

/**
 * `baron init`: explain the plan, gather credentials (gitignored), introspect the provider, propose a
 * role/type/gap mapping, let a human confirm it, then write `.baron/policy.json` (committed). All I/O
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
  announcePlan(options.prompter, options.issuesProvider);

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

  // Make init a single command: gather any missing credentials (auto-detecting GitHub owner/repo
  // from the git remote, prompting for the token) and write .baron/credentials, so the user need not
  // hand-create that file before running. An injected introspector (tests) still needs a complete
  // env, so gathering runs either way. Skipped entirely when nothing is missing.
  const effectiveEnv = await ensureCredentials(
    options.fs,
    options.prompter,
    options.root,
    descriptor,
    options.env ?? {},
  );

  const introspector = options.introspector ?? createIntrospector(effectiveEnv);
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

  const steered = await ensureAgentsSteering(
    options.fs,
    options.prompter,
    options.root,
    options.force === true,
    {
      provider: options.issuesProvider,
      rolesRideLabels: proposal.roleMap.stateKey === 'label',
      sprints: manifest.issues.sprints,
      hierarchy: manifest.issues.hierarchy,
    },
  );

  options.prompter.note(`\nWrote ${BARON_DIR}/policy.json (commit it — it holds no secrets).`);
  if (steered) options.prompter.note('Added a Baron steering block to AGENTS.md.');
  options.prompter.note('Next steps:');
  options.prompter.note(
    '  • Drive it from Claude Code: `/plugin marketplace add loncadev/baron` then `/plugin install baron@baron`.',
  );
  options.prompter.note('  • Or validate the setup now: `baron doctor`.');

  return { written: true, policyPath: path, proposal };
}
