import {
  AZURE_DEVOPS_PROVIDER,
  azureDevOpsCiManifest,
  azureDevOpsCiStatusMaps,
  azureDevOpsDeployManifest,
  azureDevOpsDeployStatusMaps,
  azureDevOpsManifest,
  azureDevOpsScmManifest,
  createAzureDevOpsCiTransport,
  createAzureDevOpsDeployTransport,
  createAzureDevOpsIntrospector,
  createAzureDevOpsScmTransport,
  createAzureDevOpsTransport,
  exampleAzureDevOpsLinkMap,
} from '@lonca/baron-adapter-azure-devops';
import {
  BARON_GITHUB_CLIENT_ID,
  type DeviceAuth,
  GITHUB_PROVIDER,
  createGithubCiTransport,
  createGithubCredentialProbe,
  createGithubDeployTransport,
  createGithubDeviceAuth,
  createGithubIntrospector,
  createGithubScmTransport,
  createGithubTransport,
  exampleGithubLinkMap,
  githubCiManifest,
  githubCiStatusMaps,
  githubDeployManifest,
  githubDeployStatusMaps,
  githubManifest,
  githubScmManifest,
} from '@lonca/baron-adapter-github';
import {
  JIRA_PROVIDER,
  createJiraCredentialProbe,
  createJiraIntrospector,
  createJiraTransport,
  exampleJiraLinkMap,
  jiraManifest,
} from '@lonca/baron-adapter-jira';
import {
  BARON_LINEAR_CLIENT_ID,
  LINEAR_CALLBACK_PORT_ENV,
  LINEAR_OAUTH_CLIENT_ID_KEY,
  LINEAR_PROVIDER,
  LINEAR_REFRESH_TOKEN_KEY,
  LINEAR_TOKEN_EXPIRES_AT_KEY,
  createLinearCredentialProbe,
  createLinearIntrospector,
  createLinearPkceAuth,
  createLinearTransport,
  exampleLinearLinkMap,
  linearCallbackUri,
  linearManifest,
} from '@lonca/baron-adapter-linear';
import {
  SLACK_PROVIDER,
  createSlackNotifyTransport,
  slackNotifyManifest,
} from '@lonca/baron-adapter-slack';
import {
  BaronError,
  type BaronPolicyFile,
  BaseCiAdapter,
  BaseDeployAdapter,
  BaseIssuesAdapter,
  BaseNotifyAdapter,
  BaseScmAdapter,
  type CapabilityManifest,
  type CiManifest,
  type CiPort,
  type CiStatusMaps,
  type CiTransport,
  type CredentialProbe,
  type DeployManifest,
  type DeployPort,
  type DeployStatusMaps,
  type DeployTransport,
  type GapPolicy,
  type Introspector,
  type IssuesPort,
  type IssuesProviderConfig,
  type IssuesTransport,
  type LinkMap,
  type Logger,
  type NotifyManifest,
  type NotifyPort,
  type NotifyTransport,
  type ScmManifest,
  type ScmPort,
  type ScmTransport,
  parseGapPolicy,
  resolveIssuesConfig,
} from '@lonca/baron-core';
import {
  type NativeHttp,
  type NativeRequest,
  type NativeResponse,
  azureBasicAuth,
  jiraBasicAuth,
  runNativeRequest,
} from './native.js';

export * from './paths.js';
export * from './credentials.js';
export * from './credentials-file.js';
export * from './native.js';

/** A read-only view of process environment (credentials live here, never in committed policy). */
export type Env = Record<string, string | undefined>;

/**
 * What a live installation lends its transports beyond credentials.
 *
 * `persistCredentials` is how a credential that changes while Baron runs — a browser-issued token
 * renewed with a rotating refresh token — gets written back to wherever the installation keeps
 * credentials, keyed by the same env names it was read under. Absent in a test, or in a process
 * that holds credentials only in its environment, where a renewal lives and dies with it.
 */
export interface TransportHooks {
  readonly persistCredentials?:
    | ((patch: Readonly<Record<string, string>>) => void | Promise<void>)
    | undefined;
}

/**
 * Everything Baron's entrypoints (CLI, MCP server) need to bind a provider id to live behavior: its
 * capability manifest, the env keys carrying its credentials (scaffolded into
 * `.baron/credentials.example`, never committed), and factories for the live transport + introspector.
 * This is shared infrastructure deliberately kept out of any single entrypoint so the CLI and the
 * MCP server depend on it rather than on each other.
 */
export interface ProviderDescriptor {
  readonly id: string;
  /** The name a person knows the provider by, for prose that lists what Baron speaks to. */
  readonly displayName: string;
  /**
   * Human onboarding help shown by `baron init` before it asks for a token: where to create one and
   * exactly which permissions it needs. Provider-specific, so each provider owns its own guidance —
   * a new user should never have to guess which token to make.
   */
  readonly credentialsHelp?: readonly string[];
  // A provider implements SOME ports, not all (e.g. Slack is notify-only) — every port group is
  // optional, and the matching build*Port throws *_UNSUPPORTED when its group is absent.
  // issues port
  readonly manifest?: CapabilityManifest;
  readonly credentialEnvKeys?: readonly string[];
  /** Fixed abstract→native link types (provider knowledge, not policy); see {@link buildIssuesPort}. */
  readonly linkMap?: LinkMap;
  createTransport?(env: Env, hooks?: TransportHooks): IssuesTransport;
  createIntrospector?(env: Env): Introspector;
  /**
   * Asks the provider what this credential may actually do. Optional: a provider with no way to
   * answer simply has none, and `doctor` reports its capabilities as unconfirmed rather than
   * assuming them — which is the whole point (invariant #5 applied to credentials).
   */
  createCredentialProbe?(env: Env): CredentialProbe;
  /**
   * Interactive credential acquisition, where the provider supports it and this installation has an
   * app id to use. Absent means the only way in is a token the user assembles by hand — which works,
   * and is what every install did, but discovers each permission mistake by failing.
   */
  createDeviceAuth?(env: Env): DeviceAuth | undefined;
  // scm port
  readonly scmManifest?: ScmManifest;
  /** Env keys for the scm transport (Azure adds AZURE_DEVOPS_REPO over the issues keys). */
  readonly scmCredentialEnvKeys?: readonly string[];
  createScmTransport?(env: Env): ScmTransport;
  // ci port
  readonly ciManifest?: CiManifest;
  readonly ciStatusMaps?: CiStatusMaps;
  readonly ciCredentialEnvKeys?: readonly string[];
  createCiTransport?(env: Env): CiTransport;
  // notify port
  readonly notifyManifest?: NotifyManifest;
  readonly notifyCredentialEnvKeys?: readonly string[];
  createNotifyTransport?(env: Env): NotifyTransport;
  // deploy port
  readonly deployManifest?: DeployManifest;
  readonly deployStatusMaps?: DeployStatusMaps;
  readonly deployCredentialEnvKeys?: readonly string[];
  createDeployTransport?(env: Env): DeployTransport;
  // provider-native escape hatch (decision #18): raw authenticated REST, last resort, non-portable
  readonly nativeHttp?: NativeHttp;
}

const DESCRIPTORS: Record<string, ProviderDescriptor> = {
  [JIRA_PROVIDER]: {
    id: JIRA_PROVIDER,
    displayName: 'Jira',
    credentialsHelp: [
      'Jira Cloud needs an API token, the email it belongs to, the site, and a project key.',
      '  1. Create the token at: https://id.atlassian.com/manage-profile/security/api-tokens',
      '  2. JIRA_SITE is the site root, e.g. https://acme.atlassian.net',
      '  3. JIRA_EMAIL is the Atlassian account the token was created under.',
      '  4. JIRA_PROJECT is the project KEY, the prefix on its issue keys (PROJ in PROJ-123).',
      '  The token needs Browse Projects, Create Issues, Edit Issues, Transition Issues, Add',
      '  Comments and Link Issues on that project — the defaults for a project member.',
      '  Sprints come from the project’s first Scrum board; set JIRA_BOARD (id or name) to pick',
      '  another. Optional — a project with no Scrum board simply has no sprints.',
    ],
    manifest: jiraManifest,
    credentialEnvKeys: ['JIRA_SITE', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT'],
    linkMap: exampleJiraLinkMap,
    createTransport(env) {
      return createJiraTransport({
        site: env.JIRA_SITE ?? '',
        email: env.JIRA_EMAIL ?? '',
        apiToken: env.JIRA_API_TOKEN ?? '',
        project: env.JIRA_PROJECT ?? '',
        // Sprints belong to a Scrum board; optional, defaults to the project's first one.
        ...(env.JIRA_BOARD ? { board: env.JIRA_BOARD } : {}),
      });
    },
    createIntrospector(env) {
      return createJiraIntrospector({
        site: env.JIRA_SITE ?? '',
        email: env.JIRA_EMAIL ?? '',
        apiToken: env.JIRA_API_TOKEN ?? '',
        project: env.JIRA_PROJECT ?? '',
      });
    },
    createCredentialProbe(env) {
      return createJiraCredentialProbe({
        site: env.JIRA_SITE ?? '',
        email: env.JIRA_EMAIL ?? '',
        apiToken: env.JIRA_API_TOKEN ?? '',
        project: env.JIRA_PROJECT ?? '',
      });
    },
    // The site root rather than /rest/api/2: the agile API (sprints, boards) lives under
    // /rest/agile/1.0 on the same host, and the escape hatch is precisely for what the adapter
    // does not cover yet.
    nativeHttp: {
      baseUrl: (env) => (env.JIRA_SITE ?? '').replace(/\/+$/, ''),
      authHeader: (env) => jiraBasicAuth(env.JIRA_EMAIL ?? '', env.JIRA_API_TOKEN ?? ''),
    },
  },
  [LINEAR_PROVIDER]: {
    id: LINEAR_PROVIDER,
    displayName: 'Linear',
    credentialsHelp: [
      'Linear needs a personal API key and the team new issues are created in.',
      '  1. Create the key at: Settings -> Security & access -> Personal API keys',
      '  2. LINEAR_TEAM is the team KEY, the prefix on its issue ids (ENG in ENG-123).',
      '',
      'Note the header, because the failure is misleading: a personal API key is sent as a bare',
      '`Authorization: <key>`. `Bearer` is for OAuth access tokens only, and using it with a',
      'personal key fails as "authentication required", which reads like a bad key.',
      'Or skip the key: `baron init` offers a browser sign-in (PKCE, no secret) through Baron’s own',
      'Linear application; the token it stores lasts 24 hours and is renewed on its own. Set',
      'BARON_LINEAR_CLIENT_ID to use a different application (it must list',
      `${linearCallbackUri()} as a redirect URI — Linear matches it exactly, port included;`,
      `${LINEAR_CALLBACK_PORT_ENV} moves the port if it is taken), or to empty to opt out.`,
    ],
    manifest: linearManifest,
    credentialEnvKeys: ['LINEAR_API_KEY', 'LINEAR_TEAM'],
    linkMap: exampleLinearLinkMap,
    createTransport(env, hooks) {
      // A refresh token beside the key means the key is a browser-issued access token: sent as
      // Bearer, renewed before it expires, and the rotated pair written back through the hook.
      const refreshToken = env[LINEAR_REFRESH_TOKEN_KEY];
      const clientId =
        env[LINEAR_OAUTH_CLIENT_ID_KEY] ?? env.BARON_LINEAR_CLIENT_ID ?? BARON_LINEAR_CLIENT_ID;
      const oauth =
        refreshToken !== undefined && refreshToken.length > 0 && clientId !== undefined
          ? {
              refreshToken,
              clientId,
              expiresAt: env[LINEAR_TOKEN_EXPIRES_AT_KEY],
              persist: hooks?.persistCredentials,
            }
          : undefined;
      return createLinearTransport({
        apiKey: env.LINEAR_API_KEY ?? '',
        team: env.LINEAR_TEAM ?? '',
        ...(oauth !== undefined ? { oauth } : {}),
      });
    },
    createIntrospector(env) {
      return createLinearIntrospector({ apiKey: env.LINEAR_API_KEY ?? '' });
    },
    createCredentialProbe(env) {
      return createLinearCredentialProbe({
        apiKey: env.LINEAR_API_KEY ?? '',
        team: env.LINEAR_TEAM ?? '',
      });
    },
    createDeviceAuth(env) {
      // Offered on a bare install through Baron's own public application, as GitHub is: a client
      // id grants nothing by itself. Linear has no device flow; this is the authorization-code
      // flow with PKCE and a loopback callback. Set BARON_LINEAR_CLIENT_ID to use a different
      // application, or to empty to opt out (a personal key is narrower than any OAuth scope).
      const clientId = env.BARON_LINEAR_CLIENT_ID ?? BARON_LINEAR_CLIENT_ID;
      if (clientId.length === 0) return undefined;
      const port = env[LINEAR_CALLBACK_PORT_ENV];
      return createLinearPkceAuth({
        clientId,
        ...(env.BARON_LINEAR_SCOPE !== undefined ? { scope: env.BARON_LINEAR_SCOPE } : {}),
        ...(port !== undefined && port.length > 0 ? { port: Number(port) } : {}),
      });
    },
  },
  [AZURE_DEVOPS_PROVIDER]: {
    id: AZURE_DEVOPS_PROVIDER,
    displayName: 'Azure DevOps',
    credentialsHelp: [
      'Azure DevOps needs a Personal Access Token (PAT).',
      '  1. Create one at: https://dev.azure.com/{your-org}/_usersSettings/tokens',
      '  2. Scopes: Work Items = Read, write, & manage; Code = Read & Write (branches + PRs).',
      '  3. Copy the token — you only see it once.',
      "  ORG / PROJECT / REPO are coordinates, not secrets; only the token is secret. If you're in the",
      '  repo now, they may be prefilled — otherwise enter them when asked.',
    ],
    manifest: azureDevOpsManifest,
    credentialEnvKeys: ['AZURE_DEVOPS_ORG', 'AZURE_DEVOPS_PROJECT', 'AZURE_DEVOPS_TOKEN'],
    linkMap: exampleAzureDevOpsLinkMap,
    createTransport(env) {
      return createAzureDevOpsTransport({
        organization: env.AZURE_DEVOPS_ORG ?? '',
        project: env.AZURE_DEVOPS_PROJECT ?? '',
        token: env.AZURE_DEVOPS_TOKEN ?? '',
        // Iterations are team-scoped; optional, defaults to Azure's "${project} Team".
        ...(env.AZURE_DEVOPS_TEAM ? { team: env.AZURE_DEVOPS_TEAM } : {}),
      });
    },
    createIntrospector(env) {
      return createAzureDevOpsIntrospector({
        organization: env.AZURE_DEVOPS_ORG ?? '',
        project: env.AZURE_DEVOPS_PROJECT ?? '',
        token: env.AZURE_DEVOPS_TOKEN ?? '',
      });
    },
    scmManifest: azureDevOpsScmManifest,
    scmCredentialEnvKeys: [
      'AZURE_DEVOPS_ORG',
      'AZURE_DEVOPS_PROJECT',
      'AZURE_DEVOPS_REPO',
      'AZURE_DEVOPS_TOKEN',
    ],
    createScmTransport(env) {
      return createAzureDevOpsScmTransport({
        organization: env.AZURE_DEVOPS_ORG ?? '',
        project: env.AZURE_DEVOPS_PROJECT ?? '',
        repository: env.AZURE_DEVOPS_REPO ?? '',
        token: env.AZURE_DEVOPS_TOKEN ?? '',
        ...(env.AZURE_DEVOPS_BASE_BRANCH !== undefined
          ? { baseBranch: env.AZURE_DEVOPS_BASE_BRANCH }
          : {}),
      });
    },
    ciManifest: azureDevOpsCiManifest,
    ciStatusMaps: azureDevOpsCiStatusMaps,
    ciCredentialEnvKeys: ['AZURE_DEVOPS_ORG', 'AZURE_DEVOPS_PROJECT', 'AZURE_DEVOPS_TOKEN'],
    createCiTransport(env) {
      return createAzureDevOpsCiTransport({
        organization: env.AZURE_DEVOPS_ORG ?? '',
        project: env.AZURE_DEVOPS_PROJECT ?? '',
        token: env.AZURE_DEVOPS_TOKEN ?? '',
      });
    },
    deployManifest: azureDevOpsDeployManifest,
    deployStatusMaps: azureDevOpsDeployStatusMaps,
    deployCredentialEnvKeys: ['AZURE_DEVOPS_ORG', 'AZURE_DEVOPS_PROJECT', 'AZURE_DEVOPS_TOKEN'],
    createDeployTransport(env) {
      return createAzureDevOpsDeployTransport({
        organization: env.AZURE_DEVOPS_ORG ?? '',
        project: env.AZURE_DEVOPS_PROJECT ?? '',
        token: env.AZURE_DEVOPS_TOKEN ?? '',
      });
    },
    nativeHttp: {
      baseUrl: (env) => `https://dev.azure.com/${env.AZURE_DEVOPS_ORG ?? ''}`,
      authHeader: (env) => azureBasicAuth(env.AZURE_DEVOPS_TOKEN ?? ''),
    },
  },
  [GITHUB_PROVIDER]: {
    id: GITHUB_PROVIDER,
    displayName: 'GitHub',
    credentialsHelp: [
      'Set BARON_GITHUB_CLIENT_ID to an OAuth/GitHub App id and `baron init` offers browser sign-in',
      'instead of any of this. Without it, or if you want the narrower credential:',
      '',
      'GitHub needs a fine-grained personal access token (PAT).',
      '  1. Create one at: https://github.com/settings/personal-access-tokens/new',
      '  2. Repository access: "Only select repositories" → the repo you are setting up.',
      '  3. Repository permissions (all Read and write):',
      '       Contents  (cut branches, read the default branch)',
      '       Issues    (create / update / comment / assign / label)',
      '       Pull requests  (open PRs + threads)',
      '     Metadata (Read) is added automatically. Add Actions (Read) + Commit statuses (Read) so',
      '     PR status can see CI — a fine-grained token cannot be granted Checks at all (that',
      '     permission exists only for GitHub Apps), so those two are the only way in. Without them',
      "     task-land reports the checks rollup as 'unknown' rather than assuming green.",
      '  4. Generate and copy the token — it starts with github_pat_ and is shown once.',
    ],
    manifest: githubManifest,
    credentialEnvKeys: ['GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_TOKEN'],
    linkMap: exampleGithubLinkMap,
    createTransport(env) {
      return createGithubTransport({
        owner: env.GITHUB_OWNER ?? '',
        repo: env.GITHUB_REPO ?? '',
        token: env.GITHUB_TOKEN ?? '',
      });
    },
    createIntrospector(env) {
      return createGithubIntrospector({
        owner: env.GITHUB_OWNER ?? '',
        repo: env.GITHUB_REPO ?? '',
        token: env.GITHUB_TOKEN ?? '',
      });
    },
    createDeviceAuth(env) {
      // Defaults to Baron's own app so the flow is offered out of the box — an id nobody ships is a
      // feature nobody gets. Set BARON_GITHUB_CLIENT_ID to use a different app, or to empty to opt
      // out of the offer entirely and go back to pasting a token.
      const clientId = env.BARON_GITHUB_CLIENT_ID ?? BARON_GITHUB_CLIENT_ID;
      if (clientId.length === 0) return undefined;
      return createGithubDeviceAuth({
        clientId,
        ...(env.BARON_GITHUB_SCOPE !== undefined ? { scope: env.BARON_GITHUB_SCOPE } : {}),
      });
    },
    createCredentialProbe(env) {
      return createGithubCredentialProbe({
        owner: env.GITHUB_OWNER ?? '',
        repo: env.GITHUB_REPO ?? '',
        token: env.GITHUB_TOKEN ?? '',
      });
    },
    scmManifest: githubScmManifest,
    scmCredentialEnvKeys: ['GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_TOKEN'],
    createScmTransport(env) {
      return createGithubScmTransport({
        owner: env.GITHUB_OWNER ?? '',
        repo: env.GITHUB_REPO ?? '',
        token: env.GITHUB_TOKEN ?? '',
        ...(env.GITHUB_BASE_BRANCH !== undefined ? { baseBranch: env.GITHUB_BASE_BRANCH } : {}),
      });
    },
    ciManifest: githubCiManifest,
    ciStatusMaps: githubCiStatusMaps,
    ciCredentialEnvKeys: ['GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_TOKEN'],
    createCiTransport(env) {
      return createGithubCiTransport({
        owner: env.GITHUB_OWNER ?? '',
        repo: env.GITHUB_REPO ?? '',
        token: env.GITHUB_TOKEN ?? '',
      });
    },
    deployManifest: githubDeployManifest,
    deployStatusMaps: githubDeployStatusMaps,
    deployCredentialEnvKeys: ['GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_TOKEN'],
    createDeployTransport(env) {
      return createGithubDeployTransport({
        owner: env.GITHUB_OWNER ?? '',
        repo: env.GITHUB_REPO ?? '',
        token: env.GITHUB_TOKEN ?? '',
      });
    },
    nativeHttp: {
      baseUrl: () => 'https://api.github.com',
      authHeader: (env) => `Bearer ${env.GITHUB_TOKEN ?? ''}`,
    },
  },
  [SLACK_PROVIDER]: {
    id: SLACK_PROVIDER,
    displayName: 'Slack',
    // Slack is notify-only: no issues/scm/ci groups.
    notifyManifest: slackNotifyManifest,
    notifyCredentialEnvKeys: ['SLACK_BOT_TOKEN', 'SLACK_CHANNEL'],
    createNotifyTransport(env) {
      return createSlackNotifyTransport({
        token: env.SLACK_BOT_TOKEN ?? '',
        ...(env.SLACK_CHANNEL !== undefined ? { defaultChannel: env.SLACK_CHANNEL } : {}),
      });
    },
    nativeHttp: {
      baseUrl: () => 'https://slack.com/api',
      authHeader: (env) => `Bearer ${env.SLACK_BOT_TOKEN ?? ''}`,
    },
  },
};

/**
 * Re-exported so a consumer can name a provider without writing the literal. The CLI needs GitHub by
 * name to offer it for the scm port when the issues provider has no source control of its own.
 */
export { AZURE_DEVOPS_PROVIDER, GITHUB_PROVIDER, LINEAR_PROVIDER, SLACK_PROVIDER };

export const KNOWN_PROVIDERS = Object.keys(DESCRIPTORS);

export function getProviderDescriptor(id: string): ProviderDescriptor {
  const descriptor = DESCRIPTORS[id];
  if (descriptor === undefined) {
    throw new BaronError(
      `Unknown provider '${id}'. Known providers: ${KNOWN_PROVIDERS.join(', ')}.`,
      'UNKNOWN_PROVIDER',
    );
  }
  return descriptor;
}

/**
 * Build a live {@link IssuesPort} from a resolved policy config plus environment credentials: looks
 * up the provider, creates its live transport, and wraps it in the shared {@link BaseIssuesAdapter}
 * (which carries all role/native translation — invariant #4). This is the one call the MCP server
 * needs to turn a `policy.json` into a working issues port.
 */
export function buildIssuesPort(
  config: IssuesProviderConfig,
  env: Env,
  logger?: Logger,
  hooks?: TransportHooks,
): IssuesPort {
  const descriptor = getProviderDescriptor(config.provider);
  if (descriptor.manifest === undefined || descriptor.createTransport === undefined) {
    throw new BaronError(
      `Provider '${config.provider}' has no issues adapter.`,
      'ISSUES_UNSUPPORTED',
    );
  }
  // The link map is fixed provider knowledge (not in policy.json), so inject the descriptor's
  // unless the caller already supplied one.
  const resolved: IssuesProviderConfig = {
    ...config,
    linkMap: config.linkMap ?? descriptor.linkMap ?? {},
  };
  return new BaseIssuesAdapter(
    descriptor.manifest,
    resolved,
    descriptor.createTransport(env, hooks),
    logger,
  );
}

/**
 * Build a live {@link ScmPort} for a provider from environment credentials. The scm port has no
 * role/type map to resolve from policy, so it binds directly from the provider id + env + an
 * optional gap policy.
 */
export function buildScmPort(
  provider: string,
  env: Env,
  gapPolicy?: GapPolicy,
  logger?: Logger,
): ScmPort {
  const descriptor = getProviderDescriptor(provider);
  if (descriptor.scmManifest === undefined || descriptor.createScmTransport === undefined) {
    throw new BaronError(`Provider '${provider}' has no scm adapter.`, 'SCM_UNSUPPORTED');
  }
  return new BaseScmAdapter(
    descriptor.scmManifest,
    descriptor.createScmTransport(env),
    gapPolicy,
    logger,
  );
}

/**
 * Build a live {@link CiPort} for a provider from environment credentials. Like scm, the ci port has
 * no user-configured map to resolve from policy (CI statuses are vendor-fixed and normalized by the
 * adapter), so it binds from the provider id + env + an optional gap policy.
 */
export function buildCiPort(
  provider: string,
  env: Env,
  gapPolicy?: GapPolicy,
  logger?: Logger,
): CiPort {
  const descriptor = getProviderDescriptor(provider);
  if (
    descriptor.ciManifest === undefined ||
    descriptor.ciStatusMaps === undefined ||
    descriptor.createCiTransport === undefined
  ) {
    throw new BaronError(`Provider '${provider}' has no ci adapter.`, 'CI_UNSUPPORTED');
  }
  return new BaseCiAdapter(
    descriptor.ciManifest,
    descriptor.ciStatusMaps,
    descriptor.createCiTransport(env),
    gapPolicy,
    logger,
  );
}

/**
 * Build a live {@link NotifyPort} for a provider from environment credentials. Like scm/ci, notify
 * has no user-configured map in policy, so it binds from the provider id + env + an optional gap policy.
 */
export function buildNotifyPort(
  provider: string,
  env: Env,
  gapPolicy?: GapPolicy,
  logger?: Logger,
): NotifyPort {
  const descriptor = getProviderDescriptor(provider);
  if (descriptor.notifyManifest === undefined || descriptor.createNotifyTransport === undefined) {
    throw new BaronError(`Provider '${provider}' has no notify adapter.`, 'NOTIFY_UNSUPPORTED');
  }
  return new BaseNotifyAdapter(
    descriptor.notifyManifest,
    descriptor.createNotifyTransport(env),
    gapPolicy,
    logger,
  );
}

/**
 * Execute a provider-native escape-hatch request (decision #18). Looks up the provider's raw-HTTP
 * descriptor and runs the request with its base URL + auth; throws NATIVE_UNSUPPORTED if the provider
 * exposes no escape hatch. This is the last-resort, non-portable path — callers (e.g. the MCP server)
 * should restrict it to providers the active policy actually binds.
 */
export function executeNativeRequest(
  provider: string,
  env: Env,
  request: NativeRequest,
): Promise<NativeResponse> {
  const descriptor = getProviderDescriptor(provider);
  if (descriptor.nativeHttp === undefined) {
    throw new BaronError(
      `Provider '${provider}' has no native escape hatch.`,
      'NATIVE_UNSUPPORTED',
    );
  }
  return runNativeRequest(descriptor.nativeHttp, env, request);
}

/**
 * Build a live {@link DeployPort} for a provider from environment credentials. Like ci/notify, the
 * deploy port has no user-configured map in policy (deploy statuses are vendor-fixed), so it binds
 * from the provider id + env + an optional gap policy.
 */
export function buildDeployPort(
  provider: string,
  env: Env,
  gapPolicy?: GapPolicy,
  logger?: Logger,
): DeployPort {
  const descriptor = getProviderDescriptor(provider);
  if (
    descriptor.deployManifest === undefined ||
    descriptor.deployStatusMaps === undefined ||
    descriptor.createDeployTransport === undefined
  ) {
    // Require the status maps too — an empty-map fallback would silently normalize every deployment
    // to 'unknown' (a silent gap, invariant #5). Mirrors buildCiPort's requirement.
    throw new BaronError(`Provider '${provider}' has no deploy adapter.`, 'DEPLOY_UNSUPPORTED');
  }
  return new BaseDeployAdapter(
    descriptor.deployManifest,
    descriptor.deployStatusMaps,
    descriptor.createDeployTransport(env),
    gapPolicy,
    logger,
  );
}

export interface BoundPorts {
  issues?: IssuesPort;
  scm?: ScmPort;
  ci?: CiPort;
  notify?: NotifyPort;
  deploy?: DeployPort;
}

/**
 * Build every port a parsed policy binds (issues and/or scm), from environment credentials. Shared
 * by the MCP server and the CLI's `run` so both turn a `policy.json` into live ports identically;
 * neither port is built unless `providers` binds it.
 */
export function buildPorts(
  policy: BaronPolicyFile,
  env: Env,
  logger?: Logger,
  hooks?: TransportHooks,
): BoundPorts {
  const ports: BoundPorts = {};
  if (policy.providers.issues !== undefined) {
    ports.issues = buildIssuesPort(resolveIssuesConfig(policy), env, logger, hooks);
  }
  const scmProvider = policy.providers.scm;
  if (scmProvider !== undefined) {
    const gapPolicy = parseGapPolicy(policy.gapPolicy?.[scmProvider] ?? {});
    ports.scm = buildScmPort(scmProvider, env, gapPolicy, logger);
  }
  const ciProvider = policy.providers.ci;
  if (ciProvider !== undefined) {
    const gapPolicy = parseGapPolicy(policy.gapPolicy?.[ciProvider] ?? {});
    ports.ci = buildCiPort(ciProvider, env, gapPolicy, logger);
  }
  const notifyProvider = policy.providers.notify;
  if (notifyProvider !== undefined) {
    const gapPolicy = parseGapPolicy(policy.gapPolicy?.[notifyProvider] ?? {});
    ports.notify = buildNotifyPort(notifyProvider, env, gapPolicy, logger);
  }
  const deployProvider = policy.providers.deploy;
  if (deployProvider !== undefined) {
    const gapPolicy = parseGapPolicy(policy.gapPolicy?.[deployProvider] ?? {});
    ports.deploy = buildDeployPort(deployProvider, env, gapPolicy, logger);
  }
  // 'docs' is a declared port (PORT_NAMES) but has no adapter yet (v2). Binding it must fail loudly,
  // not silently no-op — a bound port that does nothing is exactly the kind of silent gap #5 forbids.
  if (policy.providers.docs !== undefined) {
    throw new BaronError(
      "The 'docs' port is declared but not implemented yet (planned for a future release); remove it from policy.providers.",
      'DOCS_UNSUPPORTED',
    );
  }
  return ports;
}
