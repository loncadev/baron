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

/**
 * Per-capability gap behavior. Keyed by capability name (string) so the same policy shape serves
 * every port (issues, scm, ...). Capabilities absent from the map default to `error` (strict).
 */
export type GapPolicy = Partial<Record<string, GapBehavior>>;

/**
 * How provider mutations are allowed to reach a provider.
 *
 *  - `open`      : any primitive may be called directly. The default, and what every install had
 *                  before this existed.
 *  - `recipe-only`: only `baron_recipe_run` may mutate. Decision #19 says a recipe runs as one
 *                  deterministic call and the ENGINE enforces the step order — which was true of the
 *                  engine and false of the server, since every mutating primitive sat in the same
 *                  tool list. Hiding them would not be enforcement; refusing them is.
 */
export const MUTATION_CHANNELS = ['open', 'recipe-only'] as const;

export type MutationChannel = (typeof MUTATION_CHANNELS)[number];

export function isMutationChannel(value: string): value is MutationChannel {
  return (MUTATION_CHANNELS as readonly string[]).includes(value);
}

/**
 * Named groups of MCP tools, one per port area, so an install can publish a subset.
 *
 * Cursor caps a session at 40 tools in TOTAL. Publishing everything a policy binds means a typical
 * issues+scm install spends 27 of that budget and cannot sit next to the provider MCP servers Baron
 * is meant to sit above — the opposite of the point.
 */
export const TOOLSETS = [
  'issues',
  'scm',
  'ci',
  'deploy',
  'notify',
  'recipes',
  'knowledge',
  'native',
] as const;

export type Toolset = (typeof TOOLSETS)[number];

export function isToolset(value: string): value is Toolset {
  return (TOOLSETS as readonly string[]).includes(value);
}

/**
 * Which tools an install publishes.
 *
 *  - `all`     : everything the bound ports offer. The default, because the shipped Claude Code
 *                skills call mutating primitives directly — `minimal` would hide the tools they
 *                name and break them out of the box. Flipping this waits on those skills going
 *                through recipes.
 *  - `minimal` : the recipe channel whole, plus every tool that does not change a provider. Baron's
 *                own argument is that work goes through recipes, so the primitives that mutate are
 *                the ones you opt into. On an issues+scm install this is 11 tools rather than 27 —
 *                including the knowledge loop, which writes Baron's own store and no provider's.
 *  - a list    : exactly these toolsets, and nothing else.
 */
export const TOOL_PUBLICATION_PRESETS = ['all', 'minimal'] as const;

export type ToolPublicationPreset = (typeof TOOL_PUBLICATION_PRESETS)[number];

export type ToolPublication = ToolPublicationPreset | readonly Toolset[];

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
 * Port-agnostic gap resolution. `supported` is whether the provider has the capability (read from
 * the relevant port's manifest by the caller). `error` throws; `emulate` and `degrade` both return
 * `proceed: true` after logging a warning so the gap is never silent. Used by every port.
 */
export function resolveCapabilityGap(
  supported: boolean,
  capability: string,
  provider: string,
  policy: GapPolicy,
  logger: Logger,
): GapResolution {
  if (supported) {
    return { proceed: true, behavior: { kind: 'emulate', strategy: 'native' } };
  }

  const behavior = policy[capability] ?? { kind: 'error' };

  if (behavior.kind === 'error') {
    throw new CapabilityGapError(capability, provider);
  }

  logger.warn(`capability gap handled by '${behavior.kind}' policy`, {
    capability,
    provider,
    strategy: behavior.kind === 'emulate' ? behavior.strategy : undefined,
  });

  return { proceed: true, behavior };
}

/** Issues-port gap resolution: reads the capability from the issues manifest. */
export function resolveGap(
  capability: CapabilityName,
  manifest: CapabilityManifest,
  policy: GapPolicy,
  logger: Logger,
): GapResolution {
  return resolveCapabilityGap(
    manifest.issues[capability],
    capability,
    manifest.provider,
    policy,
    logger,
  );
}
