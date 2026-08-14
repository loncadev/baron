import { spawn } from 'node:child_process';
import { platform, stdout } from 'node:process';

/** Per-platform "open this in whatever handles it". No dependency earns its place for three lines. */
const OPENER: Readonly<Record<string, readonly [string, readonly string[]]>> = {
  win32: ['cmd', ['/c', 'start', '']],
  darwin: ['open', []],
};
const FALLBACK_OPENER: readonly [string, readonly string[]] = ['xdg-open', []];

/**
 * Try to open `url` in the user's browser. Returns whether the attempt was made — never throws, and
 * never blocks.
 *
 * Deliberately best-effort. The caller must have already printed the URL, because every reason this
 * fails is a reason the user still needs it: a headless box, an SSH session, a container, a desktop
 * with no handler registered. An opener that could turn a working sign-in into a dead end would be
 * worse than no opener at all.
 *
 * Skipped when stdout is not a TTY: no terminal means nobody is watching, and a script that pipes
 * our output has not asked us to take over its display.
 */
export function openInBrowser(url: string, spawnImpl: typeof spawn = spawn): boolean {
  if (!stdout.isTTY) return false;
  const [command, prefix] = OPENER[platform] ?? FALLBACK_OPENER;
  try {
    const child = spawnImpl(command, [...prefix, url], { stdio: 'ignore', detached: true });
    // Errors arrive asynchronously (ENOENT for a missing xdg-open, say); swallowing them here keeps
    // an unhandled 'error' event from taking the process down mid-sign-in.
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
