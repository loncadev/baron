import type { GapPolicy, NotifyPort, RecordingLogger } from '@lonca/baron-core';
import { describe, expect, it } from 'vitest';

export interface NotifyConformanceTarget {
  readonly label: string;
  /** Build a fresh notify adapter (in-memory transport) with the given gap policy, plus its logger. */
  build(gapPolicy?: GapPolicy): { adapter: NotifyPort; logger: RecordingLogger };
}

/**
 * The contract every `notify` adapter must satisfy. Notify is uniform enough across providers that
 * this asserts the same shape for all of them; the channels/threads capability gaps are unit-tested
 * in core where a provider lacking them can be simulated.
 */
export function runNotifyConformance(target: NotifyConformanceTarget): void {
  describe(`notify conformance: ${target.label}`, () => {
    it('declares the notify capabilities as booleans', () => {
      const { adapter } = target.build();
      for (const key of ['channels', 'threads', 'richText'] as const) {
        expect(typeof adapter.manifest.notify[key]).toBe('boolean');
      }
    });

    it('sends a message and returns a normalized notification', async () => {
      const { adapter } = target.build();
      const sent = await adapter.send({ text: 'hello from conformance' });
      expect(sent.id).toBeTruthy();
    });

    it('returns a threadKey when the provider supports threads', async () => {
      const { adapter } = target.build();
      if (!adapter.manifest.notify.threads) return;
      const sent = await adapter.send({ text: 'parent' });
      expect(typeof sent.threadKey).toBe('string');
    });
  });
}
