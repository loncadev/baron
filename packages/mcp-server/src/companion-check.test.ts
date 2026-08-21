import { describe, expect, it } from 'vitest';
import { COMPANION_VERSION_ENV, companionNotice } from './companion-check.js';

const at = (declared: string | undefined, serverVersion = '0.34.0') =>
  companionNotice({
    serverVersion,
    env: declared === undefined ? {} : { [COMPANION_VERSION_ENV]: declared },
  });

describe('a client and a server that are not the same release', () => {
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

  it('tells the other half when the SERVER is the one behind', () => {
    // This direction was silent, on the reasoning that a newer client means someone pinned the
    // server back deliberately. Shipping 0.36.0 disproved it: skills ship through the marketplace
    // and the recipes they call ship through npm, so a plugin ahead of its server is the ordinary
    // state between two updates — and 0.36.0's task-sync skill calls a recipe 0.35.0 never had.
    const notice = at('0.36.0');
    expect(notice).toContain('0.36.0');
    expect(notice).toContain('0.34.0');
    expect(notice, 'it told the user to update the half that is already current').not.toContain(
      '/plugin update',
    );
    expect(notice, 'the remedy for a behind server is to restart it').toContain('restart');
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
