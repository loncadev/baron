import { type Logger, silentLogger } from './logger.js';
import { type GapPolicy, resolveCapabilityGap } from './policy.js';

/**
 * What a `notify` adapter supports. The core consults this before an operation and applies the gap
 * policy for anything `false` (e.g. a threaded reply on a provider without threads) — never silent.
 */
export interface NotifyCapabilities {
  /** Messages can target a named channel (vs. a single fixed destination). */
  channels: boolean;
  /** Replies can be threaded under a parent message (via `threadKey`). */
  threads: boolean;
  /** Rich/markdown formatting is rendered (vs. plain text only). */
  richText: boolean;
}
export type NotifyCapabilityName = keyof NotifyCapabilities;

/** Self-description a `notify` adapter exposes so the core can negotiate gaps. */
export interface NotifyManifest {
  provider: string;
  notify: NotifyCapabilities;
}

/** Input to `notify.send` — a provider-agnostic message. */
export interface NotifyMessage {
  readonly text: string;
  /** Target channel/room; requires the `channels` capability. */
  readonly channel?: string | undefined;
  /** Thread to reply under (an opaque key from a prior {@link Notification}); requires `threads`. */
  readonly threadKey?: string | undefined;
}

/** A normalized sent-notification reference, independent of the backing provider. */
export interface Notification {
  readonly id: string;
  readonly url?: string | undefined;
  /** Opaque key to thread future replies under this message (when the provider supports threads). */
  readonly threadKey?: string | undefined;
}

/** Native sent-notification the transport returns. */
export interface NativeNotification {
  readonly id: string;
  readonly url?: string | undefined;
  readonly threadKey?: string | undefined;
}

/**
 * The thin, provider-specific transport a `notify` adapter delegates I/O to. Real implementations
 * call the vendor SDK/webhook; the conformance suite passes an in-memory fake.
 */
export interface NotifyTransport {
  send(message: NotifyMessage): Promise<NativeNotification>;
}

/** The normalized primitive surface the core exposes for the `notify` port. */
export interface NotifyPort {
  readonly manifest: NotifyManifest;
  send(message: NotifyMessage): Promise<Notification>;
}

/**
 * Provider-agnostic implementation of the `notify` primitive. Capability-gap negotiation lives here:
 * targeting a channel on a provider without channels, or threading a reply on one without threads, is
 * decided by policy (error / degrade / emulate), never silently dropped. A concrete adapter supplies
 * only a {@link NotifyManifest} and a {@link NotifyTransport}.
 */
export class BaseNotifyAdapter implements NotifyPort {
  constructor(
    readonly manifest: NotifyManifest,
    private readonly transport: NotifyTransport,
    private readonly gapPolicy: GapPolicy = {},
    private readonly logger: Logger = silentLogger,
  ) {}

  async send(message: NotifyMessage): Promise<Notification> {
    if (message.channel !== undefined && !this.manifest.notify.channels) {
      resolveCapabilityGap(false, 'channels', this.manifest.provider, this.gapPolicy, this.logger);
    }
    if (message.threadKey !== undefined && !this.manifest.notify.threads) {
      resolveCapabilityGap(false, 'threads', this.manifest.provider, this.gapPolicy, this.logger);
    }
    const native = await this.transport.send(message);
    return { id: native.id, url: native.url, threadKey: native.threadKey };
  }
}
