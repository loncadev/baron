import type { NativeNotification, NotifyMessage, NotifyTransport } from '@baron/core';

/**
 * In-memory stand-in for a `notify` transport. Deterministic and network-free so the notify
 * conformance suite (and port/MCP logic) run without a live messaging provider; the live transports
 * are validated separately by gated smoke tests.
 */
export function createMemoryNotifyTransport(): NotifyTransport {
  let seq = 0;
  return {
    async send(message: NotifyMessage): Promise<NativeNotification> {
      seq += 1;
      const id = `mem-msg-${seq}`;
      // Echo the parent thread when replying, else start a new thread keyed by this message.
      return { id, url: `mem://notify/${id}`, threadKey: message.threadKey ?? id };
    },
  };
}
