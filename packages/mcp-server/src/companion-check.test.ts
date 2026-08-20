import { describe, expect, it } from 'vitest';
import { COMPANION_VERSION_ENV, companionNotice } from './companion-check.js';

const at = (declared: string | undefined, serverVersion = '0.34.0') =>
  companionNotice({
    serverVersion,
    env: declared === undefined ? {} : { [COMPANION_VERSION_ENV]: declared },
  });

describe('a client whose Baron artifacts are older than the server it launched', () => {
  it('is told which two versions disagree, and how to fix it', () => {
    // The failure this catches: a plugin frozen before the tool consolidation hands an agent skills
    // naming tools this server no longer publishes. Naming both versions is the point — "something
    // is out of date" leaves the user guessing which of the two halves to move.
    const notice = at('0.31.1');
    expect(notice).toContain('0.31.1');
    expect(notice).toContain('0.34.0');
    expect(notice, 'a warning with no remedy is a complaint').toContain('/plugin update');
  });

  it('says nothing when the two agree', () => {
    expect(at('0.34.0')).toBeUndefined();
  });

  it('says nothing when the client is newer, which is someone pinning the server back', () => {
    expect(at('0.35.0')).toBeUndefined();
  });

  it('says nothing when no companion declares itself', () => {
    // A hand-wired `.mcp.json` has no skills or steering of its own to be stale, and every install
    // predating this check sends nothing. Warning them all would be crying wolf — the surest way to
    // get a warning ignored, and this one has to be believed on the day it fires.
    expect(at(undefined)).toBeUndefined();
    expect(at('')).toBeUndefined();
    expect(at('   ')).toBeUndefined();
  });

  it('says nothing rather than guessing when a version is unreadable', () => {
    expect(at('nightly')).toBeUndefined();
    expect(at('0.34.0', 'nightly')).toBeUndefined();
  });
});
