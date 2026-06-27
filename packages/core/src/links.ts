/**
 * Abstract, non-hierarchy link types between issues. Parent/child hierarchy is handled separately
 * (via `create(parentId)` + the hierarchy capability/gap), so these cover the lateral relationships.
 * Providers map them onto native link types (Azure `System.LinkTypes.*`) via the adapter's link map;
 * providers without native typed links (GitHub) negotiate the gap (`error` / `emulate` / `degrade`).
 */
export const ISSUE_LINK_TYPES = ['relates', 'blocks', 'blocked_by', 'duplicates'] as const;

export type IssueLinkType = (typeof ISSUE_LINK_TYPES)[number];

export function isIssueLinkType(value: string): value is IssueLinkType {
  return (ISSUE_LINK_TYPES as readonly string[]).includes(value);
}
