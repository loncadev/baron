import { describe, expect, it } from 'vitest';
import { interpolate } from './interpolate.js';

const ctx = {
  issue: { id: '7', key: '#7', nested: { deep: 'value' } },
  found: [{ key: '#1' }, { key: '#2' }, { key: '#3' }],
  empty: [] as unknown[],
};

describe('interpolate', () => {
  it('resolves a dotted path to any depth', () => {
    expect(interpolate('${issue.nested.deep}', ctx)).toBe('value');
    expect(interpolate('item ${issue.key} here', ctx)).toBe('item #7 here');
  });

  // Without this a query recipe could not say how many items it found, and — the sharper problem —
  // could not GUARD on a count. `require: falsy: ${found.length}` read as falsy on every run,
  // including the runs where the query DID find something.
  it('reads the length of a list', () => {
    expect(interpolate('${found.length}', ctx)).toBe(3);
    expect(interpolate('found ${found.length} item(s)', ctx)).toBe('found 3 item(s)');
  });

  it('distinguishes an empty list from a non-empty one, so a guard can too', () => {
    expect(interpolate('${empty.length}', ctx)).toBe(0);
    expect(interpolate('${found.length}', ctx)).toBe(3);
  });

  it('indexes into a list', () => {
    expect(interpolate('${found.0.key}', ctx)).toBe('#1');
    expect(interpolate('${found.2.key}', ctx)).toBe('#3');
    expect(interpolate('${found.9.key}', ctx)).toBeUndefined();
  });

  // A recipe reads data. Exposing array methods would put a function into an interpolated string,
  // and the reserved keys would put JavaScript's own machinery there.
  it('refuses array methods and prototype keys', () => {
    for (const path of [
      '${found.map}',
      '${found.filter}',
      '${found.constructor}',
      '${issue.constructor}',
      '${issue.__proto__}',
      '${found.-1}',
      '${found.1x}',
    ]) {
      expect(interpolate(path, ctx), path).toBeUndefined();
    }
  });

  it('still yields undefined for a missing hop rather than throwing', () => {
    expect(interpolate('${nope.at.all}', ctx)).toBeUndefined();
    expect(interpolate('${issue.missing}', ctx)).toBeUndefined();
  });
});
