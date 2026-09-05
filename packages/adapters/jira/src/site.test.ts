import { describe, expect, it } from 'vitest';
import { normalizeSite } from './site.js';

describe('normalizeSite', () => {
  it('accepts the site the way Atlassian shows it, with or without a scheme or trailing slash', () => {
    expect(normalizeSite('https://acme.atlassian.net')).toBe('https://acme.atlassian.net');
    expect(normalizeSite('https://acme.atlassian.net/')).toBe('https://acme.atlassian.net');
    expect(normalizeSite('acme.atlassian.net')).toBe('https://acme.atlassian.net');
    expect(normalizeSite('  acme.atlassian.net/  ')).toBe('https://acme.atlassian.net');
    // A self-hosted context path survives; only the trailing slash goes.
    expect(normalizeSite('https://jira.example.com/jira/')).toBe('https://jira.example.com/jira');
  });

  it('refuses a value that is not a site, naming the variable and the shape it wants', () => {
    // The first live `baron init` saved "n" here and failed with a raw "Failed to parse URL".
    for (const bad of ['n', '', 'not a url', 'ftp://acme.atlassian.net']) {
      expect(() => normalizeSite(bad)).toThrow(/JIRA_SITE is '.*'.*https:\/\/acme\.atlassian\.net/);
      expect(() => normalizeSite(bad)).toThrow(expect.objectContaining({ code: 'JIRA_CONFIG' }));
    }
  });
});
