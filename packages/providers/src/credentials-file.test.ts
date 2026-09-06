import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCredentialsFileHooks, upsertCredentials } from './credentials-file.js';
import { credentialsPath } from './paths.js';

describe('upsertCredentials', () => {
  it('replaces a present key in place and appends a new one, leaving everything else alone', () => {
    const before = [
      '# Baron credentials — never commit.',
      'LINEAR_TEAM=BAR',
      'LINEAR_API_KEY=old',
      '',
      '# my note',
      'LINEAR_REFRESH_TOKEN=r1',
      '',
    ].join('\n');
    const after = upsertCredentials(before, {
      LINEAR_API_KEY: 'new',
      LINEAR_REFRESH_TOKEN: 'r2',
      LINEAR_TOKEN_EXPIRES_AT: '2026-09-07T12:00:00.000Z',
    });
    expect(after).toBe(
      [
        '# Baron credentials — never commit.',
        'LINEAR_TEAM=BAR',
        'LINEAR_API_KEY=new',
        '',
        '# my note',
        'LINEAR_REFRESH_TOKEN=r2',
        'LINEAR_TOKEN_EXPIRES_AT=2026-09-07T12:00:00.000Z',
        '',
      ].join('\n'),
    );
  });

  it('creates the file content from nothing', () => {
    expect(upsertCredentials('', { A: '1' })).toBe('A=1\n');
  });
});

describe('createCredentialsFileHooks', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('writes a rotated pair back into <root>/.baron/credentials, creating the file if needed', () => {
    const root = mkdtempSync(join(tmpdir(), 'baron-creds-'));
    dirs.push(root);
    const hooks = createCredentialsFileHooks(root);

    hooks.persistCredentials?.({ LINEAR_API_KEY: 'a', LINEAR_REFRESH_TOKEN: 'r' });
    expect(readFileSync(credentialsPath(root), 'utf8')).toBe(
      'LINEAR_API_KEY=a\nLINEAR_REFRESH_TOKEN=r\n',
    );

    writeFileSync(
      credentialsPath(root),
      '# kept\nLINEAR_TEAM=BAR\nLINEAR_API_KEY=a\nLINEAR_REFRESH_TOKEN=r\n',
    );
    hooks.persistCredentials?.({ LINEAR_API_KEY: 'b', LINEAR_REFRESH_TOKEN: 'r2' });
    expect(readFileSync(credentialsPath(root), 'utf8')).toBe(
      '# kept\nLINEAR_TEAM=BAR\nLINEAR_API_KEY=b\nLINEAR_REFRESH_TOKEN=r2\n',
    );
  });
});
