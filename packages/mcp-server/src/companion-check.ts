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
 * The notice when the client's artifacts are older than this server, else undefined.
 *
 * Only an OLDER companion is reported. A newer one means the user is running a released plugin
 * against a server they pinned back, which is a deliberate act, and equality is the normal case.
 * Nothing here throws or blocks: it reads one string.
 */
export function companionNotice(options: CompanionCheckOptions): string | undefined {
  const declared = (options.env ?? process.env)[COMPANION_VERSION_ENV];
  if (declared === undefined || declared.trim().length === 0) return undefined;
  if (compareSemver(declared, options.serverVersion) >= 0) return undefined;
  return formatCompanionNotice(declared.trim(), options.serverVersion);
}
