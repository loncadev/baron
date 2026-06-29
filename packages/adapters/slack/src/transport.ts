import {
  BaronError,
  type NativeNotification,
  type NotifyMessage,
  type NotifyTransport,
} from '@baron/core';

export interface SlackNotifyTransportOptions {
  /** Slack bot token (xoxb-…). Read from env / secret-manager by the caller; never committed. */
  readonly token: string;
  /** Default channel id/name used when a message does not specify one. */
  readonly defaultChannel?: string;
}

const CHAT_POST_MESSAGE = 'https://slack.com/api/chat.postMessage';

/**
 * Live `notify` transport over the Slack Web API (`chat.postMessage`) using global fetch — no SDK
 * dependency. Threads ride on Slack's `thread_ts` (returned as the message `ts`, which Baron surfaces
 * as the opaque `threadKey`). Slack's `ok:false` responses are surfaced as a BaronError, never silent.
 */
export function createSlackNotifyTransport(options: SlackNotifyTransportOptions): NotifyTransport {
  const { token, defaultChannel } = options;

  return {
    async send(message: NotifyMessage): Promise<NativeNotification> {
      const channel = message.channel ?? defaultChannel;
      if (channel === undefined || channel.length === 0) {
        throw new BaronError(
          'Slack requires a channel; set SLACK_CHANNEL or pass `channel`.',
          'NOTIFY_NO_CHANNEL',
        );
      }
      const response = await fetch(CHAT_POST_MESSAGE, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          channel,
          text: message.text,
          ...(message.threadKey !== undefined ? { thread_ts: message.threadKey } : {}),
        }),
      });
      const data = (await response.json()) as { ok: boolean; ts?: string; error?: string };
      if (!data.ok) {
        throw new BaronError(
          `Slack chat.postMessage failed: ${data.error ?? 'unknown error'}.`,
          'NOTIFY_SEND_FAILED',
        );
      }
      const ts = data.ts ?? '';
      return { id: ts, threadKey: ts };
    },
  };
}
