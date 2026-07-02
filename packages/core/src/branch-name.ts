import type { WorkItemTypeRole } from './roles.js';

/**
 * Deterministic branch naming from a work item: `<prefix>/<id>-<slug>`. This is a first-class,
 * provider-agnostic concept (not workflow opinion): every agent and recipe touching the same work
 * item must derive the SAME branch name, or PR auto-linking and resumability break silently.
 * Modeled on the Beetegre-V2 `task-branch-from-workitem` discipline that Baron abstracts.
 */

/**
 * Type-role → branch prefix. `undefined` means "never branch directly on this" (epics/initiatives
 * are containers; branch on a child story/task/bug instead).
 */
export const BRANCH_TYPE_PREFIXES: Readonly<Record<WorkItemTypeRole, string | undefined>> = {
  initiative: undefined,
  epic: undefined,
  story: 'feature',
  task: 'task',
  bug: 'bug',
  subtask: 'task',
};

/** Slug budget for the title portion (prefix, id, and separators are not counted). */
const SLUG_MAX = 60;

// Locale fold for characters NFD decomposition alone cannot map (Turkish dotless/dotted I pair
// plus ø/æ/ß-style letters that are not base+combining-mark compositions).
const LOCALE_FOLD: Readonly<Record<string, string>> = {
  ı: 'i',
  İ: 'i',
  ø: 'o',
  æ: 'ae',
  œ: 'oe',
  ß: 'ss',
  đ: 'd',
  ł: 'l',
};

/**
 * Normalize a work-item title to a kebab-case ASCII slug: locale fold (ç→c, ğ→g, ı→i, …),
 * non-alphanumeric runs collapse to single dashes, and truncation to {@link SLUG_MAX} never splits
 * a word (walks back to the previous dash).
 */
export function slugifyTitle(title: string): string {
  const folded = title
    .replace(/[ıİøæœßđł]/g, (ch) => LOCALE_FOLD[ch] ?? ch)
    .normalize('NFD')
    // biome-ignore lint/suspicious/noMisleadingCharacterClass: stripping combining marks is the point
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (folded.length <= SLUG_MAX) return folded;
  const cut = folded.slice(0, SLUG_MAX);
  const boundary = cut.lastIndexOf('-');
  return boundary > 0 ? cut.slice(0, boundary) : cut;
}

/**
 * Derive the canonical branch name for a work item, or `undefined` when no branch should be cut
 * for it (container types — epic/initiative — and items whose native type is unmapped). Callers
 * treat `undefined` as "refuse and ask for a child item", never as "invent a name".
 */
export function deriveBranchName(issue: {
  readonly id: string;
  readonly title: string;
  readonly typeRole?: WorkItemTypeRole | undefined;
}): string | undefined {
  if (issue.typeRole === undefined) return undefined;
  const prefix = BRANCH_TYPE_PREFIXES[issue.typeRole];
  if (prefix === undefined) return undefined;
  const slug = slugifyTitle(issue.title);
  return slug.length > 0 ? `${prefix}/${issue.id}-${slug}` : `${prefix}/${issue.id}`;
}
