import { describe, expect, it } from 'vitest';
import { mergeCredentials, parseCredentials } from './credentials.js';

describe('parseCredentials', () => {
  it('parses KEY=VALUE lines, ignoring comments and blanks', () => {
    const text = `
# Azure DevOps
AZURE_DEVOPS_ORG=beekod

AZURE_DEVOPS_PROJECT = BeeMaster
`;
    expect(parseCredentials(text)).toEqual({
      AZURE_DEVOPS_ORG: 'beekod',
      AZURE_DEVOPS_PROJECT: 'BeeMaster',
    });
  });

  it('keeps = inside a value and strips surrounding quotes', () => {
    expect(parseCredentials('AZURE_DEVOPS_TOKEN="a=b=c"')).toEqual({
      AZURE_DEVOPS_TOKEN: 'a=b=c',
    });
  });
});

describe('mergeCredentials', () => {
  it('overlays file values under the real environment (env wins)', () => {
    const merged = mergeCredentials(
      { AZURE_DEVOPS_TOKEN: 'from-env' },
      'AZURE_DEVOPS_TOKEN=from-file\nAZURE_DEVOPS_ORG=beekod',
    );
    expect(merged.AZURE_DEVOPS_TOKEN).toBe('from-env');
    expect(merged.AZURE_DEVOPS_ORG).toBe('beekod');
  });

  it('returns the base env unchanged when no file is present', () => {
    const base = { A: '1' };
    expect(mergeCredentials(base, undefined)).toBe(base);
  });
});
