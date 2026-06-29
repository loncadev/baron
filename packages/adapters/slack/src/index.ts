import {
  BaseNotifyAdapter,
  type GapPolicy,
  type Logger,
  type NotifyManifest,
  type NotifyTransport,
} from '@baron/core';
import { SLACK_PROVIDER } from './provider.js';

export { SLACK_PROVIDER } from './provider.js';

/** Slack supports channels, threaded replies (`thread_ts`), and mrkdwn rich text. */
export const slackNotifyManifest: NotifyManifest = {
  provider: SLACK_PROVIDER,
  notify: { channels: true, threads: true, richText: true },
};

/**
 * Builds the Slack `notify` port. The adapter contributes only the manifest; the shared
 * {@link BaseNotifyAdapter} carries the capability-gap negotiation.
 */
export function defineSlackNotifyAdapter(
  transport: NotifyTransport,
  gapPolicy?: GapPolicy,
  logger?: Logger,
): BaseNotifyAdapter {
  return new BaseNotifyAdapter(slackNotifyManifest, transport, gapPolicy, logger);
}

export { createSlackNotifyTransport, type SlackNotifyTransportOptions } from './transport.js';
