import type { spawn } from 'node:child_process';
import { platform, stdout } from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openInBrowser } from './open-browser.js';

/** `isTTY` is a plain property on the stream, so a test can state which world it is in. */
function withTTY(isTTY: boolean): void {
  Object.defineProperty(stdout, 'isTTY', { value: isTTY, configurable: true });
}
const originalIsTTY = stdout.isTTY;
afterEach(() => withTTY(originalIsTTY as boolean));

/** Records the launch instead of performing it: a test must never open a real browser. */
function recordingSpawn() {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const impl = ((command: string, args: readonly string[]) => {
    calls.push({ command, args });
    return { on: () => {}, unref: () => {} };
  }) as unknown as typeof spawn;
  return { impl, calls };
}

const URL = 'https://github.com/login/device?user_code=ABCD-1234';

describe('openInBrowser', () => {
  it('does nothing when stdout is not a terminal', () => {
    // No terminal means nobody is watching, and a caller piping our output has not asked us to take
    // over their display.
    withTTY(false);
    const { impl, calls } = recordingSpawn();
    expect(openInBrowser(URL, impl)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('hands the URL to the platform opener as its own argument', () => {
    withTTY(true);
    const { impl, calls } = recordingSpawn();
    expect(openInBrowser(URL, impl)).toBe(true);
    // Passed as an argv entry, never interpolated into a command string — a device URL carries a
    // query string, and building a shell line out of it is how you get a mangled or unsafe command.
    expect(calls[0]?.args).toContain(URL);
    if (platform === 'win32') expect(calls[0]?.command).toBe('cmd');
  });

  it('reports failure instead of throwing when the opener cannot be launched', () => {
    // Every reason this fails — headless, SSH, a container, no registered handler — is a reason the
    // caller has already printed the URL. Turning a working sign-in into a crash would make the
    // convenience strictly worse than not having it.
    withTTY(true);
    const exploding = vi.fn(() => {
      throw new Error('ENOENT: xdg-open');
    }) as unknown as typeof spawn;
    expect(openInBrowser(URL, exploding)).toBe(false);
  });
});
