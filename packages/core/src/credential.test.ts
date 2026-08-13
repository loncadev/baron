import { describe, expect, it } from 'vitest';
import { requiredCredentialCapabilities } from './credential.js';

describe('requiredCredentialCapabilities', () => {
  it('asks each provider only for what the ports bound to IT imply', () => {
    const required = requiredCredentialCapabilities({ issues: 'linear', scm: 'github' });
    expect(required.get('linear')).toEqual(['issues:read', 'issues:write']);
    expect(required.get('github')).toEqual(['scm:read', 'scm:write']);
  });

  it('merges the ports one provider serves without duplicating a capability', () => {
    const required = requiredCredentialCapabilities({ issues: 'github', scm: 'github' });
    expect(required.get('github')).toEqual([
      'issues:read',
      'issues:write',
      'scm:read',
      'scm:write',
    ]);
  });

  // A token bound to nothing is asked to prove nothing — the same rule that keeps unbound ports out
  // of the published tool surface.
  it('requires nothing for a port that is bound but implies no credential capability', () => {
    expect(requiredCredentialCapabilities({ notify: 'slack' }).size).toBe(0);
    expect(requiredCredentialCapabilities({}).size).toBe(0);
  });
});
