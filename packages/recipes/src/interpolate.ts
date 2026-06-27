export type RecipeContext = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolve a dotted path (e.g. `issue.id`) against the run context; undefined if any hop is missing. */
function resolvePath(context: RecipeContext, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((acc, key) => (isRecord(acc) ? acc[key] : undefined), context);
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
