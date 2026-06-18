import { describe, expect, it } from 'vitest';
import type { CapabilityManifest } from './capabilities.js';
import { CapabilityGapError } from './errors.js';
import { RecordingLogger } from './logger.js';
import { parseGapBehavior, parseGapPolicy, resolveGap } from './policy.js';

describe('parseGapBehavior', () => {
  it('parses the three forms', () => {
    expect(parseGapBehavior('error')).toEqual({ kind: 'error' });
    expect(parseGapBehavior('degrade')).toEqual({ kind: 'degrade' });
    expect(parseGapBehavior('emulate:labels')).toEqual({ kind: 'emulate', strategy: 'labels' });
  });

  it('rejects an empty emulate strategy and unknown forms', () => {
    expect(() => parseGapBehavior('emulate:')).toThrow();
    expect(() => parseGapBehavior('nonsense')).toThrow();
  });
});

describe('parseGapPolicy', () => {
  it('parses a record of capability -> behavior', () => {
    expect(parseGapPolicy({ hierarchy: 'emulate:labels', sprints: 'degrade' })).toEqual({
      hierarchy: { kind: 'emulate', strategy: 'labels' },
      sprints: { kind: 'degrade' },
    });
  });
});

const githubManifest: CapabilityManifest = {
  provider: 'github',
  issues: {
    hierarchy: false,
    subIssues: true,
    separateBoardColumn: false,
    sprints: false,
    arbitraryStates: false,
    nativeLabels: true,
  },
};

describe('resolveGap', () => {
  it('proceeds natively when the capability is supported', () => {
    const log = new RecordingLogger();
    const res = resolveGap('subIssues', githubManifest, {}, log);
    expect(res.proceed).toBe(true);
    expect(log.entries).toHaveLength(0);
  });

  it('throws on a gap when no policy is set (strict default)', () => {
    const log = new RecordingLogger();
    expect(() => resolveGap('hierarchy', githubManifest, {}, log)).toThrow(CapabilityGapError);
  });

  it('emulates and logs a warning (never silent)', () => {
    const log = new RecordingLogger();
    const res = resolveGap(
      'hierarchy',
      githubManifest,
      { hierarchy: { kind: 'emulate', strategy: 'labels' } },
      log,
    );
    expect(res.proceed).toBe(true);
    expect(res.behavior).toEqual({ kind: 'emulate', strategy: 'labels' });
    expect(log.entries.filter((e) => e.level === 'warn')).toHaveLength(1);
  });

  it('degrades and logs a warning', () => {
    const log = new RecordingLogger();
    const res = resolveGap('sprints', githubManifest, { sprints: { kind: 'degrade' } }, log);
    expect(res.proceed).toBe(true);
    expect(log.entries.some((e) => e.level === 'warn')).toBe(true);
  });
});
