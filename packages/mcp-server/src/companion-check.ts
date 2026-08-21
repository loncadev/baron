/**
 * Detect a client whose Baron artifacts are older than the server they launched.
 *
 * The plugin pins its skills and steering to a commit and never moves them, while the same manifest
 * launches this server with `npx @latest`, which moves on every restart. Nothing compared the two, so
 * they drifted apart in silence — and the drift is not cosmetic: a plugin frozen before the tool
 * consolidation hands an agent instructions naming tools this server no longer publishes, and every
 * one of those calls fails at the moment the agent tries to act.
 *
 * The plugin declares its own version as a literal in the manifest's `env`, so the check needs no
 * filesystem access, no path substitution, and no network. Silence is the answer whenever there is
 * nothing to compare: a hand-wired `.mcp.json` has no companion artifacts to be stale.
 */
import { compareSemver } from './update-check.js';

/** Set by the plugin manifest to the version its skills and steering shipped at. */
export const COMPANION_VERSION_ENV = 'BARON_PLUGIN_VERSION';

export interface CompanionCheckOptions {
  readonly serverVersion: string;
  readonly env?: Record<string, string | undefined>;
}

export function formatCompanionNotice(companion: string, server: string): string {
  return (
    `⚠️ The Baron plugin here is v${companion} but this server is v${server}. Its skills and ` +
    'steering are from the older release and may name tools this server no longer publishes, so ' +
    'calls made from them can fail. Update with `/plugin marketplace update baron` then ' +
    '`/plugin update baron@baron`.'
  );
}

/**
 * The other direction, and the remedy is the opposite one: the SERVER is what is behind.
 *
 * Skills ship through the plugin marketplace and the recipes and tools they call ship through npm,
 * so a plugin newer than its server is not someone pinning deliberately — it is the ordinary state
 * between two updates. v0.36.0 made that concrete: its task-sync skill calls a recipe a v0.35.0
 * server has never heard of, and without this the failure is an unknown-recipe error explaining
 * nothing.
 */
export function formatServerBehindNotice(companion: string, server: string): string {
  return (
    `⚠️ The Baron plugin here is v${companion} but this server is v${server}. Its skills may call ` +
    'recipes and tools this older server does not have. If your launcher uses ' +
    '`@lonca/baron-mcp-server@latest`, restart the MCP server to pick the new one up; if it pins a ' +
    'version, raise it.'
  );
}

/**
 * The notice when the client and this server are not the same release, else undefined.
 *
 * Both directions are reported, with opposite remedies, because both happen without anyone choosing
 * them: the skills and the code they call are published through different channels, so either half
 * can be the one in front. Equality is the normal case and says nothing; so does a client that
 * declares no version, since there is then nothing to compare. Nothing here throws or blocks — it
 * reads one string.
 */
export function companionNotice(options: CompanionCheckOptions): string | undefined {
  const declared = (options.env ?? process.env)[COMPANION_VERSION_ENV];
  if (declared === undefined || declared.trim().length === 0) return undefined;
  const order = compareSemver(declared.trim(), options.serverVersion);
  // 0 covers both "same release" and "not comparable" — neither is something to warn about.
  if (order === 0) return undefined;
  return order < 0
    ? formatCompanionNotice(declared.trim(), options.serverVersion)
    : formatServerBehindNotice(declared.trim(), options.serverVersion);
}
