import type { CapabilityManifest, CapabilityName } from './capabilities.js';
import { CapabilityGapError } from './errors.js';
import type { Logger } from './logger.js';

/**
 * What to do when an operation needs a capability the provider lacks.
 *  - error   : fail loudly with an actionable message
 *  - emulate : synthesize it with a named strategy (e.g. GitHub hierarchy via labels)
 *  - degrade : skip it, but always log a warning (never silent)
 */
export type GapBehavior =
  | { readonly kind: 'error' }
  | { readonly kind: 'emulate'; readonly strategy: string }
  | { readonly kind: 'degrade' };

/** Per-capability gap behavior. Capabilities absent from the map default to `error` (strict). */
export type GapPolicy = Partial<Record<CapabilityName, GapBehavior>>;

/**
 * Parse the on-disk string form into a GapBehavior.
 *   'error' | 'degrade' | 'emulate:labels' | 'emulate:sub-issues'
 */
export function parseGapBehavior(raw: string): GapBehavior {
  if (raw === 'error') return { kind: 'error' };
  if (raw === 'degrade') return { kind: 'degrade' };
  if (raw.startsWith('emulate:')) {
    const strategy = raw.slice('emulate:'.length).trim();
    if (strategy.length === 0) {
      throw new Error(`Invalid gap behavior '${raw}': 'emulate:' requires a strategy name.`);
    }
    return { kind: 'emulate', strategy };
  }
  throw new Error(
    `Invalid gap behavior '${raw}'. Expected 'error', 'degrade', or 'emulate:<strategy>'.`,
  );
}

export function parseGapPolicy(raw: Record<string, string>): GapPolicy {
  const out: GapPolicy = {};
  for (const [capability, behavior] of Object.entries(raw)) {
    out[capability as CapabilityName] = parseGapBehavior(behavior);
  }
  return out;
}

export interface GapResolution {
  /** Whether the operation may proceed (true for emulate/degrade, never for error). */
  readonly proceed: boolean;
  readonly behavior: GapBehavior;
}

/**
 * Decide what happens for one needed-but-unsupported capability. `error` throws; `emulate` and
 * `degrade` both return `proceed: true` after logging a warning so the gap is never silent.
 */
export function resolveGap(
  capability: CapabilityName,
  manifest: CapabilityManifest,
  policy: GapPolicy,
  logger: Logger,
): GapResolution {
  if (manifest.issues[capability]) {
    return { proceed: true, behavior: { kind: 'emulate', strategy: 'native' } };
  }

  const behavior = policy[capability] ?? { kind: 'error' };

  if (behavior.kind === 'error') {
    throw new CapabilityGapError(capability, manifest.provider);
  }

  logger.warn(`capability gap handled by '${behavior.kind}' policy`, {
    capability,
    provider: manifest.provider,
    strategy: behavior.kind === 'emulate' ? behavior.strategy : undefined,
  });

  return { proceed: true, behavior };
}
