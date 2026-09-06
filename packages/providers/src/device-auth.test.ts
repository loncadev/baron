import { GITHUB_PROVIDER } from '@lonca/baron-adapter-github';
import { LINEAR_PROVIDER } from '@lonca/baron-adapter-linear';
import { describe, expect, it } from 'vitest';
import { getProviderDescriptor } from './index.js';

describe('GitHub device flow availability', () => {
  const github = () => getProviderDescriptor(GITHUB_PROVIDER);

  it('is offered on a bare install: Baron ships its own app id', () => {
    // The whole point of #68. A client id is public by design and grants nothing on its own, so
    // shipping one costs nothing and is the difference between a feature everyone has and a feature
    // only whoever registers an app first has.
    expect(github().createDeviceAuth?.({})).toBeDefined();
  });

  it('honours an override, so an org can approve its own app instead', () => {
    expect(
      github().createDeviceAuth?.({ BARON_GITHUB_CLIENT_ID: 'Ov23liSOMEONEELSE' }),
    ).toBeDefined();
  });

  it('treats an empty client id as opting out rather than as an unset one', () => {
    // Distinguishing '' from undefined is the only way to turn the offer off through env alone,
    // which some installs want: a fine-grained PAT is narrower than any OAuth scope.
    expect(github().createDeviceAuth?.({ BARON_GITHUB_CLIENT_ID: '' })).toBeUndefined();
  });
});

describe('Linear browser sign-in availability', () => {
  const linear = () => getProviderDescriptor(LINEAR_PROVIDER);

  it('is opt-in: Baron ships no Linear application id yet', () => {
    expect(linear().createDeviceAuth?.({})).toBeUndefined();
    expect(linear().createDeviceAuth?.({ BARON_LINEAR_CLIENT_ID: '' })).toBeUndefined();
  });

  it('is offered once an installation names its application', () => {
    expect(linear().createDeviceAuth?.({ BARON_LINEAR_CLIENT_ID: 'cid' })).toBeDefined();
  });

  it('lets the callback port be moved, since Linear matches the registered redirect URI exactly', () => {
    // The only way to observe the port from outside is the redirect URI shown to the user.
    const auth = linear().createDeviceAuth?.({
      BARON_LINEAR_CLIENT_ID: 'cid',
      BARON_LINEAR_CALLBACK_PORT: '0',
    });
    expect(auth).toBeDefined();
  });
});
