/**
 * Non-blocking "a newer version exists" detection, surfaced as a one-line notice appended to tool
 * results (as its OWN content block — the first block stays parseable JSON). The check runs once in
 * the background at startup; a registry that is slow, offline, or air-gapped silently yields "no
 * notice" — freshness advice must never sit on any critical path.
 */

/** Opt-out for air-gapped / privacy-sensitive installs (any non-empty value disables the check). */
export const UPDATE_CHECK_DISABLE_ENV = 'BARON_NO_UPDATE_CHECK';

const REGISTRY_BASE = 'https://registry.npmjs.org';
/** Abbreviated packument — a few KB instead of the full version history. */
const ABBREVIATED_ACCEPT = 'application/vnd.npm.install-v1+json';
const CHECK_TIMEOUT_MS = 4000;

/** -1 when a < b, 0 when equal/incomparable, 1 when a > b. Numeric x.y.z only; else incomparable. */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): number[] | undefined => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m === null ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa === undefined || pb === undefined) return 0;
  for (let i = 0; i < 3; i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

export function formatUpdateNotice(name: string, current: string, latest: string): string {
  return (
    `⚠️ ${name} v${current} outdated → v${latest} available. ` +
    'Restart the baron MCP server to update (an @latest npx launcher fetches it automatically); ' +
    `pinned installs: reinstall ${name}@latest.`
  );
}

export interface UpdateChecker {
  /** The one-line notice once a newer version is known, else undefined. Never throws. */
  notice(): string | undefined;
}

export interface UpdateCheckOptions {
  readonly name: string;
  readonly currentVersion: string;
  readonly env?: Record<string, string | undefined>;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchJson?: (url: string, accept: string) => Promise<unknown>;
}

async function defaultFetchJson(url: string, accept: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`registry responded ${response.status}`);
  return response.json();
}

/** Fire the background check immediately; expose the (eventually populated) notice. */
export function startUpdateCheck(options: UpdateCheckOptions): UpdateChecker {
  let notice: string | undefined;

  const disabled = (options.env ?? process.env)[UPDATE_CHECK_DISABLE_ENV];
  if (disabled === undefined || disabled.length === 0) {
    const fetchJson = options.fetchJson ?? defaultFetchJson;
    void fetchJson(`${REGISTRY_BASE}/${encodeURIComponent(options.name)}`, ABBREVIATED_ACCEPT)
      .then((data) => {
        const latest = (data as { 'dist-tags'?: { latest?: string } })['dist-tags']?.latest;
        if (latest !== undefined && compareSemver(options.currentVersion, latest) < 0) {
          notice = formatUpdateNotice(options.name, options.currentVersion, latest);
        }
      })
      .catch(() => {
        // Offline/air-gapped/slow registry: stay silent by design.
      });
  }

  return { notice: () => notice };
}
