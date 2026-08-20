import {
  BaronError,
  type BaronPolicyFile,
  type Introspector,
  type NativeTarget,
  type ProviderProposal,
  WORK_ITEM_TYPE_ROLES,
  parsePolicy,
  proposePolicy,
  serializePolicy,
} from '@lonca/baron-core';
import {
  type Env,
  GITHUB_PROVIDER,
  KNOWN_PROVIDERS,
  type ProviderDescriptor,
  getProviderDescriptor,
  mergeCredentials,
  parseCredentials,
} from '@lonca/baron-providers';
import { openInBrowser } from './open-browser.js';
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
  /** Provider to bind to the issues port. When omitted, init prompts the user to pick one. */
  readonly issuesProvider?: string;
  readonly fs: FileSystem;
  readonly prompter: Prompter;
  /** Injected introspector (tests). When absent, built from the registry + env credentials. */
  readonly introspector?: Introspector;
  readonly env?: Env;
  /** Overwrite an existing policy without confirming. */
  readonly force?: boolean;
  /** Injected browser opener (tests). Returns whether an attempt was made. */
  readonly openBrowser?: (url: string) => boolean;
  /**
   * Work the caller must finish before init signs off — provisioning the provider's workflow labels,
   * today. A callback rather than something the caller runs after `runInit` returns, because the
   * closing advice has to come last and a caller cannot make that true from outside.
   */
  readonly afterWrite?: (policyPath: string) => Promise<void>;
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
 * `scmProvider` closes the same dead-end from the other side: a provider that ships no scm adapter at
 * all (Linear) can still take branches and PRs from somewhere else, and until this existed that was
 * the one setup where hand-editing the file was mandatory rather than optional. The gap policy is
 * only emitted when the provider actually has gaps, so a fully-capable provider produces a clean file.
 */
export function assemblePolicy(
  proposal: ProviderProposal,
  opts: { bindScm?: boolean; scmProvider?: string } = {},
): BaronPolicyFile {
  const hasGaps = Object.keys(proposal.gapPolicy).length > 0;
  const object = {
    version: 1 as const,
    providers: {
      issues: proposal.provider,
      ...(opts.bindScm === true
        ? { scm: proposal.provider }
        : opts.scmProvider !== undefined
          ? { scm: opts.scmProvider }
          : {}),
    },
    roleMap: { [proposal.provider]: proposal.roleMap },
    typeMap: { [proposal.provider]: proposal.typeMap },
    ...(hasGaps ? { gapPolicy: { [proposal.provider]: proposal.gapPolicy } } : {}),
  };
  // Round-trip through the loader so init can never emit a policy the loader would later reject.
  return parsePolicy(JSON.parse(JSON.stringify(object)));
}

function credentialsTemplate(
  descriptor: ProviderDescriptor,
  scmDescriptor?: ProviderDescriptor,
): string {
  const header = `# Credentials for '${descriptor.id}'. Copy this file to '${BARON_DIR}/credentials'\n# (gitignored) or export these in your environment. Never commit real values.\n`;
  // Union of the issues + scm credential keys (deduped), so a policy that binds both ports lists
  // every variable the user must fill — e.g. Azure's scm adds AZURE_DEVOPS_REPO over the issues set.
  const keys = [
    ...new Set([
      ...(descriptor.credentialEnvKeys ?? []),
      ...(descriptor.scmCredentialEnvKeys ?? []),
      // A mixed setup needs the scm provider's keys listed too, or the template documents half of
      // what the install actually reads.
      ...(scmDescriptor?.scmCredentialEnvKeys ?? []),
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
function scaffoldCredentials(
  fs: FileSystem,
  root: string,
  descriptor: ProviderDescriptor,
  scmDescriptor?: ProviderDescriptor,
): void {
  const examplePath = credentialsExamplePath(root);
  if (!fs.exists(examplePath)) {
    fs.write(examplePath, credentialsTemplate(descriptor, scmDescriptor));
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
  /** `--force` means "do not ask me"; a browser sign-in is nothing but asking. */
  nonInteractive: boolean,
  openBrowser: (url: string) => boolean,
  /**
   * The provider filling the scm port when it is not the issues provider. Its keys are gathered in
   * the same pass, because two credential prompts separated by an introspection is how a user ends
   * up with half a setup.
   */
  scmDescriptor?: ProviderDescriptor,
): Promise<Env> {
  // Which provider each key belongs to, so the guidance shown and the browser sign-in offered are
  // the ones for the provider actually being asked about.
  const ownerOf = new Map<string, ProviderDescriptor>();
  for (const key of [
    ...(descriptor.credentialEnvKeys ?? []),
    ...(descriptor.scmCredentialEnvKeys ?? []),
  ]) {
    if (!ownerOf.has(key)) ownerOf.set(key, descriptor);
  }
  for (const key of scmDescriptor?.scmCredentialEnvKeys ?? []) {
    if (!ownerOf.has(key)) ownerOf.set(key, scmDescriptor as ProviderDescriptor);
  }
  const required = [...ownerOf.keys()];
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
  const typed = missing.filter((key) => detected[key] === undefined);
  for (const owner of new Set(typed.map((key) => ownerOf.get(key)))) {
    if (owner?.credentialsHelp === undefined) continue;
    prompter.note('');
    for (const line of owner.credentialsHelp) prompter.note(line);
    prompter.note('');
  }

  // The provider can hand a token over directly where it supports it. Offered rather than forced:
  // a fine-grained PAT is narrower than any scope an OAuth app can request, so someone who wants
  // the tighter credential should not have to fight the friendlier path to get it.
  // Never on a non-interactive run. The flow waits up to fifteen minutes for a human to approve a
  // code in a browser, so offering it where nobody can answer does not degrade — it hangs.
  const tokenKey = missing.find((key) => SECRET_KEY.test(key) && detected[key] === undefined);
  const tokenOwner = tokenKey === undefined ? undefined : ownerOf.get(tokenKey);
  const deviceAuth = nonInteractive ? undefined : tokenOwner?.createDeviceAuth?.(env);
  let authorized: string | undefined;
  if (deviceAuth !== undefined && tokenKey !== undefined) {
    const useIt = await prompter.confirm(
      `Sign in to ${tokenOwner?.id} in your browser instead of pasting a token?`,
      true,
    );
    if (useIt) {
      authorized = await deviceAuth.authorize((code) => {
        prompter.note('');
        // Printed before any attempt to open a browser, and never replaced by it: every reason the
        // opener fails — headless, SSH, a container, no registered handler — is a reason the user
        // still needs to read the URL and the code off the screen.
        prompter.note(`  Open ${code.verificationUri} and enter:  ${code.userCode}`);
        // The provider's pre-filled variant, when it offers one, saves typing the code. The user
        // still confirms the code on screen matches, which is what makes the shortcut safe.
        if (openBrowser(code.verificationUriComplete ?? code.verificationUri)) {
          prompter.note('  (opening that page in your browser…)');
        }
        prompter.note(
          `  Waiting for approval (the code expires in ${Math.round(code.expiresInSeconds / 60)} min)…`,
        );
      });
      prompter.note('  Signed in.');
    }
  }

  for (const key of missing) {
    const auto = detected[key];
    if (auto !== undefined) {
      prompter.note(`  ${key} = ${auto}  (detected from your git remote)`);
      fileValues[key] = auto;
      continue;
    }
    if (key === tokenKey && authorized !== undefined) {
      fileValues[key] = authorized;
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

/**
 * What this run would do to the policy already on disk.
 *
 * The proposal alone is not enough on an upgrade: it says what the mapping WOULD be, not what is
 * about to be lost. A real installation had `done` mapped to state `Closed` with board column
 * `Resolved` — a deliberate pairing a re-proposal would quietly replace, and nothing would have said
 * so. Removals and changes are therefore called out separately from additions, and only differences
 * are printed: a list where everything is "unchanged" is one nobody reads to the end of.
 */
function summarizeChanges(
  prompter: Prompter,
  existing: string | undefined,
  proposal: ProviderProposal,
): void {
  prompter.note('\nAgainst the policy already here:');
  if (existing === undefined) {
    prompter.note('  (could not read it — this run replaces it wholesale)');
    return;
  }
  let current: BaronPolicyFile;
  try {
    current = parsePolicy(JSON.parse(existing));
  } catch (error) {
    // Unreadable is not "nothing to lose": say so, rather than print an empty diff that reads like
    // agreement between two files only one of which was understood.
    prompter.note(
      `  (the policy here could not be parsed: ${error instanceof Error ? error.message : String(error)})`,
    );
    prompter.note('  Everything in it is replaced by the mapping above.');
    return;
  }

  const flat = (
    targets: Partial<Record<string, NativeTarget>> | undefined,
  ): Record<string, string> =>
    Object.fromEntries(
      Object.entries(targets ?? {}).map(([role, target]) => [role, JSON.stringify(target)]),
    );
  const lines: string[] = [];
  const diff = (label: string, before: Record<string, string>, after: Record<string, string>) => {
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      const was = before[key];
      const now = after[key];
      if (was === now) continue;
      if (was === undefined) lines.push(`  + ${label} ${key} -> ${now}`);
      else if (now === undefined) lines.push(`  - ${label} ${key} was ${was} — this run DROPS it`);
      else lines.push(`  ~ ${label} ${key}: ${was} -> ${now}`);
    }
  };

  const before = current.roleMap[proposal.provider];
  diff('role', flat(before?.states), flat(proposal.roleMap.states));
  const scopes = [
    ...new Set([
      ...Object.keys(before?.scopes ?? {}),
      ...Object.keys(proposal.roleMap.scopes ?? {}),
    ]),
  ].sort();
  for (const scope of scopes) {
    diff(`role [${scope}]`, flat(before?.scopes?.[scope]), flat(proposal.roleMap.scopes?.[scope]));
  }
  const typesBefore = current.typeMap[proposal.provider] ?? {};
  diff(
    'type',
    Object.fromEntries(Object.entries(typesBefore).map(([k, v]) => [k, String(v)])),
    Object.fromEntries(Object.entries(proposal.typeMap).map(([k, v]) => [k, String(v)])),
  );

  if (lines.length === 0) {
    prompter.note('  nothing changes — the mapping above is what is already on disk.');
    return;
  }
  for (const line of lines) prompter.note(line);
}

function summarizeProposal(
  prompter: Prompter,
  proposal: ProviderProposal,
  bindScm: boolean,
  scmProvider?: string,
): void {
  const ports = bindScm
    ? 'issues + scm (branches/PRs)'
    : scmProvider !== undefined
      ? `issues, with scm (branches/PRs) on '${scmProvider}'`
      : 'issues';
  prompter.note(`Binding provider '${proposal.provider}' to: ${ports}.`);
  prompter.note(`Proposed mapping for issues provider '${proposal.provider}':`);
  for (const [role, target] of Object.entries(proposal.roleMap.states)) {
    prompter.note(`  role ${role} -> ${JSON.stringify(target)}`);
  }
  // A scoped provider proposes one map per scope and leaves the flat one empty, so a display that
  // only read `states` would show a confirmation screen with no mapping on it — and the whole point
  // of this screen is that a human confirms what was guessed.
  for (const [scope, states] of Object.entries(proposal.roleMap.scopes ?? {})) {
    prompter.note(`  scope ${scope}:`);
    for (const [role, target] of Object.entries(states)) {
      prompter.note(`    role ${role} -> ${JSON.stringify(target)}`);
    }
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
export interface SteeringContext {
  readonly provider: string;
  /** Roles ride labels (GitHub) vs the provider's native states (Azure). */
  readonly rolesRideLabels: boolean;
  readonly sprints: boolean;
  readonly hierarchy: boolean;
  /**
   * The type roles this policy actually maps. Steering used to list the full abstract vocabulary
   * unconditionally, so an agent following its own instructions could ask for a role the policy
   * mapped to nothing and get an error for doing exactly what it was told.
   */
  readonly typeRoles: readonly string[];
}

/**
 * Agent steering: teaches an agent to drive work through Baron's abstract vocabulary, not raw
 * provider writes. Harness-neutral (AGENTS.md), so any agent that reads it benefits. The abstract
 * core is provider-independent; a short "on this provider" note (derived from the manifest) tells the
 * agent which capabilities exist here — so a degraded capability's empty result isn't mistaken for a
 * bug (the exact confusion a flat provider caused in dogfooding).
 */
export function steeringBlock(ctx: SteeringContext): string {
  const roles = ctx.rolesRideLabels
    ? 'labels (Baron provisions `in-progress` / `in-review` / `done`)'
    : "the provider's native states";
  const sprints = ctx.sprints
    ? 'available (`baron_issue_read { op: "iterations" }`, filter by `@current`)'
    : 'NOT available — sprint queries degrade to empty. That empty is expected here, not a bug';
  const hierarchy = ctx.hierarchy ? 'native parent/child' : 'emulated via a `parent:<id>` label';
  const typeRoles =
    ctx.typeRoles.length > 0
      ? ctx.typeRoles.map((role) => `\`${role}\``).join(', ')
      : 'none — this policy maps no work-item type, so `issue.create` cannot set one';
  const body = `## Work tracking — route through Baron

Track work through **Baron**, not raw provider writes: it normalizes issues and source control across
providers behind one contract, so speak its abstract vocabulary, never a vendor's native states.

- **Roles, not native states.** Move work by role: \`backlog → ready → in_progress → in_review → done\`.
  Say "move it to in_progress", never "set the state to Active" — Baron maps the role to the provider.
- **Blocking is orthogonal, not a role.** \`baron_issue_move { op: "block", id, reason }\` and
  \`{ op: "unblock", id }\` set and clear a flag; the item keeps the role it is blocked in, so
  unblocking returns it to where the work actually was. A reason is required — an item blocked for no
  recorded reason is one nobody can unblock.
- **Type roles this policy maps:** ${typeRoles}.
  Asking for one it does not map is an error, not a degrade — that list is what \`issue.create\`
  accepts here.
- **Tools:** every write takes an \`op\`. \`baron_issue_read\` (get / query / iterations / classify),
  \`baron_issue_write\` (create / update / comment / assign / link / set_iteration),
  \`baron_issue_move\` (transition / reconcile / block / unblock), \`baron_scm_read\` and
  \`baron_scm_write\` (branch_create / pr_create / pr_thread / pr_ready / pr_merge),
  \`baron_recipe_list\` + \`baron_recipe_run\`, and \`baron_memory_append\` / \`baron_memory_query\`
  for durable decisions and follow-ups. Call \`baron_recipe_list\` if you are unsure what exists —
  do not guess a tool name.
- **Daily loop — prefer the skills:** \`/baron:task-new\` (create), \`/baron:task-start <id>\` (cut the
  canonical branch, move to in_progress, assign you), \`/baron:task-finish\` (draft PR),
  \`/baron:task-land\` (undraft + merge — never \`gh\`/\`az\`), \`/baron:task-move\`,
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

/** Ask which provider to bind when `--provider` was omitted — only those with an issues adapter. */
async function promptForProvider(prompter: Prompter): Promise<string> {
  const providers = KNOWN_PROVIDERS.filter((id) => {
    const d = getProviderDescriptor(id);
    return d.manifest !== undefined && d.createIntrospector !== undefined;
  });
  return prompter.choice('Which provider hosts your work items?', providers);
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
    'The only thing it creates on your provider is the labels Baron needs, on a provider whose ' +
      'roles or types ride labels (GitHub and Linear today); it never touches',
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
  // Missing --provider isn't a hard error: like a modern init, ask which provider to bind.
  const issuesProvider = options.issuesProvider ?? (await promptForProvider(options.prompter));
  const descriptor = getProviderDescriptor(issuesProvider);
  const { createIntrospector, manifest } = descriptor;
  if (createIntrospector === undefined || manifest === undefined) {
    throw new BaronError(
      `Provider '${issuesProvider}' has no issues adapter to initialize.`,
      'ISSUES_UNSUPPORTED',
    );
  }
  const path = policyPath(options.root);
  announcePlan(options.prompter, issuesProvider);

  // Whether this run REPLACES a policy, which changes what has to be shown before anything is asked.
  // This used to be an "Overwrite it?" prompt right here, answered before the proposal existed — and
  // on `no` it introspected anyway, built the proposal, and threw it away. So the one question an
  // upgrade turns on ("what would change?") was unanswerable without agreeing to replace the very
  // file being protected. The proposal, and what it does to what is already there, now come first.
  const replacing = options.fs.exists(path);

  // Bind scm to the same provider when it ships an scm adapter — the task-start/finish flow needs it.
  const bindScm =
    descriptor.scmManifest !== undefined && descriptor.createScmTransport !== undefined;

  // When it ships none, offer the repository git is already pointing at. Linear is the first shipped
  // provider that is issues-only, so without this every Linear install had to hand-edit
  // providers.scm before the first recipe would run — and the first recipe a new user runs is
  // task-start, which needs a branch. Decided before credentials are gathered so both providers'
  // keys are collected in one pass.
  let scmProvider: string | undefined;
  if (!bindScm) {
    const remote = detectGitCoordinates(options.fs.read(gitConfigPath(options.root)));
    const owner = remote.GITHUB_OWNER;
    const repo = remote.GITHUB_REPO;
    if (owner !== undefined && repo !== undefined) {
      const take =
        options.force === true ||
        (await options.prompter.confirm(
          `Provider '${issuesProvider}' has no source control. Take branches and pull requests ` +
            `from GitHub (${owner}/${repo}, read off your git remote)?`,
          true,
        ));
      if (take) scmProvider = GITHUB_PROVIDER;
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
    options.force === true,
    options.openBrowser ?? openInBrowser,
    scmProvider === undefined ? undefined : getProviderDescriptor(scmProvider),
  );

  const introspector = options.introspector ?? createIntrospector(effectiveEnv);
  const introspection = await introspector.introspect();
  const proposal = proposePolicy(introspection, manifest);

  summarizeProposal(options.prompter, proposal, bindScm, scmProvider);
  if (replacing) summarizeChanges(options.prompter, options.fs.read(path), proposal);

  const confirmed =
    options.force === true ||
    (await options.prompter.confirm(
      replacing ? `Overwrite ${path} with this mapping?` : `Write ${path} with this mapping?`,
      !replacing,
    ));
  if (!confirmed) {
    return { written: false, policyPath: path, proposal };
  }

  const policy = assemblePolicy(proposal, {
    bindScm,
    ...(scmProvider !== undefined ? { scmProvider } : {}),
  });
  options.fs.mkdirp(`${options.root}/${BARON_DIR}`);
  options.fs.write(path, serializePolicy(policy));
  scaffoldCredentials(
    options.fs,
    options.root,
    descriptor,
    scmProvider === undefined ? undefined : getProviderDescriptor(scmProvider),
  );

  const steered = await ensureAgentsSteering(
    options.fs,
    options.prompter,
    options.root,
    options.force === true,
    {
      provider: issuesProvider,
      rolesRideLabels: proposal.roleMap.stateKey === 'label',
      sprints: manifest.issues.sprints,
      hierarchy: manifest.issues.hierarchy,
      // Canonical order (broadest to narrowest), not the map's insertion order — the steering block
      // is read by a human as often as by an agent.
      typeRoles: WORK_ITEM_TYPE_ROLES.filter((role) => proposal.typeMap[role] !== undefined),
    },
  );

  options.prompter.note(`\nWrote ${path} (commit it — it holds no secrets).`);
  if (steered) options.prompter.note('Added a Baron steering block to AGENTS.md.');
  await options.afterWrite?.(path);
  options.prompter.note('Next steps:');
  options.prompter.note(
    '  • Drive it from Claude Code: `/plugin marketplace add loncadev/baron` then `/plugin install baron@baron`.',
  );
  options.prompter.note('  • Or validate the setup now: `baron doctor`.');

  return { written: true, policyPath: path, proposal };
}
