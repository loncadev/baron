import { describe, expect, it } from 'vitest';
import { withUpdateNotice } from './server.js';
import type { ToolResult } from './tools.js';
import {
  UPDATE_CHECK_DISABLE_ENV,
  compareSemver,
  formatUpdateNotice,
  startUpdateCheck,
} from './update-check.js';
import { OWN_PACKAGE } from './version.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('compareSemver', () => {
  it('orders numeric versions', () => {
    expect(compareSemver('0.3.0', '0.4.0')).toBe(-1);
    expect(compareSemver('0.4.0', '0.3.9')).toBe(1);
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('0.9.0', '0.10.0')).toBe(-1); // numeric, not lexicographic
  });

  it('treats unparseable versions as incomparable (no notice, never a crash)', () => {
    expect(compareSemver('garbage', '1.0.0')).toBe(0);
    expect(compareSemver('1.0.0', '')).toBe(0);
  });
});

describe('startUpdateCheck', () => {
  const registry = (latest: string) => async () => ({ 'dist-tags': { latest } });

  it('reports a notice when the registry has a newer version', async () => {
    const checker = startUpdateCheck({
      name: '@lonca/baron-mcp-server',
      currentVersion: '0.3.0',
      env: {},
      fetchJson: registry('0.4.0'),
    });
    expect(checker.notice()).toBeUndefined(); // async: not yet resolved
    await flush();
    expect(checker.notice()).toBe(formatUpdateNotice('@lonca/baron-mcp-server', '0.3.0', '0.4.0'));
  });

  it('stays silent when up to date, when the registry fails, and when opted out', async () => {
    const current = startUpdateCheck({
      name: 'x',
      currentVersion: '0.4.0',
      env: {},
      fetchJson: registry('0.4.0'),
    });
    const broken = startUpdateCheck({
      name: 'x',
      currentVersion: '0.1.0',
      env: {},
      fetchJson: async () => {
        throw new Error('offline');
      },
    });
    const optedOut = startUpdateCheck({
      name: 'x',
      currentVersion: '0.1.0',
      env: { [UPDATE_CHECK_DISABLE_ENV]: '1' },
      fetchJson: registry('9.9.9'),
    });
    await flush();
    expect(current.notice()).toBeUndefined();
    expect(broken.notice()).toBeUndefined();
    expect(optedOut.notice()).toBeUndefined();
  });
});

describe('withUpdateNotice', () => {
  const ok: ToolResult = { content: [{ type: 'text', text: '{"id":"1"}' }] };

  it('appends the notice as a SEPARATE content block, first block untouched', () => {
    const result = withUpdateNotice(ok, 'outdated!');
    expect(result.content).toHaveLength(2);
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual({ id: '1' }); // still parseable
    expect(result.content[1]?.text).toBe('outdated!');
  });

  it('leaves results untouched with no notice, and never decorates errors', () => {
    expect(withUpdateNotice(ok, undefined)).toBe(ok);
    const err: ToolResult = {
      content: [{ type: 'text', text: 'CAPABILITY_GAP: x' }],
      isError: true,
    };
    expect(withUpdateNotice(err, 'outdated!')).toBe(err);
  });
});

describe('OWN_PACKAGE', () => {
  it('reads the real package identity (fixes the hardcoded 0.0.0 serverInfo)', () => {
    expect(OWN_PACKAGE.name).toBe('@lonca/baron-mcp-server');
    expect(OWN_PACKAGE.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(OWN_PACKAGE.version).not.toBe('0.0.0');
  });
});
