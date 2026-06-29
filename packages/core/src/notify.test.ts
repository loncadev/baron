import { describe, expect, it } from 'vitest';
import { CapabilityGapError } from './errors.js';
import { RecordingLogger } from './logger.js';
import { BaseNotifyAdapter, type NotifyManifest, type NotifyTransport } from './notify.js';

const transport: NotifyTransport = {
  async send(message) {
    return { id: 'n1', url: 'mem://n1', threadKey: message.threadKey ?? 'n1' };
  },
};

const full: NotifyManifest = {
  provider: 'fake',
  notify: { channels: true, threads: true, richText: true },
};
const minimal: NotifyManifest = {
  provider: 'fake',
  notify: { channels: false, threads: false, richText: false },
};

describe('BaseNotifyAdapter', () => {
  it('sends a message and normalizes the result', async () => {
    const adapter = new BaseNotifyAdapter(full, transport);
    const sent = await adapter.send({ text: 'hi', channel: 'general' });
    expect(sent.id).toBe('n1');
    expect(sent.threadKey).toBe('n1');
  });

  it('errors on channel/thread when unsupported under the strict default policy (never silent)', async () => {
    const adapter = new BaseNotifyAdapter(minimal, transport);
    await expect(adapter.send({ text: 'hi', channel: 'x' })).rejects.toBeInstanceOf(
      CapabilityGapError,
    );
    await expect(adapter.send({ text: 'hi', threadKey: 't' })).rejects.toBeInstanceOf(
      CapabilityGapError,
    );
  });

  it('degrades and warns when a capability is unsupported but the policy allows it', async () => {
    const log = new RecordingLogger();
    const adapter = new BaseNotifyAdapter(
      minimal,
      transport,
      { channels: { kind: 'degrade' } },
      log,
    );
    const sent = await adapter.send({ text: 'hi', channel: 'x' });
    expect(sent.id).toBe('n1');
    expect(log.entries.some((e) => e.level === 'warn')).toBe(true);
  });

  it('sends a plain message with no channel/thread without invoking any gap', async () => {
    const adapter = new BaseNotifyAdapter(minimal, transport);
    const sent = await adapter.send({ text: 'plain' });
    expect(sent.id).toBe('n1');
  });
});
