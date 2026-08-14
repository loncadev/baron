export type RecipeContext = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Keys that reach JavaScript's own machinery rather than the run context. A recipe reads data; it
 * has no business walking into a prototype, and refusing here costs nothing.
 */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * One hop of a dotted path.
 *
 * Arrays answer `length` and a non-negative integer index, and nothing else. `issue.query` binds a
 * list, and without `length` a recipe could not report how many items it found — worse, it could not
 * GUARD on a count, so `require: falsy: ${found.length}` ("refuse when the query found nothing")
 * silently read as falsy and fired on every run, including the ones where the query did find
 * something. A guard that cannot express a count is a real limit on decision #19.
 *
 * Deliberately not "any array property": `map`, `filter` and friends would put functions into an
 * interpolated string, and the reserved keys below would put the prototype there.
 */
function step(acc: unknown, key: string): unknown {
  if (RESERVED_KEYS.has(key)) return undefined;
  if (Array.isArray(acc)) {
    if (key === 'length') return acc.length;
    const index = Number(key);
    return Number.isInteger(index) && index >= 0 ? acc[index] : undefined;
  }
  return isRecord(acc) ? acc[key] : undefined;
}

/** Resolve a dotted path (e.g. `issue.id`, `found.length`, `found.0.key`) against the run context. */
function resolvePath(context: RecipeContext, path: string): unknown {
  return path.split('.').reduce<unknown>(step, context);
}

/**
 * Replace `${path}` references in a value against the run context. A string that is exactly a single
 * `${path}` yields the raw resolved value (preserving non-string types and `undefined`, so an
 * optional `parentId: ${parent}` becomes undefined rather than the literal "undefined"); strings
 * with embedded references are interpolated to text. Arrays/objects are walked recursively.
 */
export function interpolate(value: unknown, context: RecipeContext): unknown {
  if (typeof value === 'string') {
    const whole = value.match(/^\$\{([^}]+)\}$/);
    if (whole?.[1] !== undefined) {
      return resolvePath(context, whole[1].trim());
    }
    return value.replace(/\$\{([^}]+)\}/g, (_match, path: string) => {
      const resolved = resolvePath(context, path.trim());
      return resolved === undefined || resolved === null ? '' : String(resolved);
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolate(item, context));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = interpolate(item, context);
    }
    return out;
  }
  return value;
}
