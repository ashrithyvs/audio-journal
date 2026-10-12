// The canonical selection identity (ADR-020): a derivation's scope is its
// set of entry IDs, deduplicated, sorted by UTF-16 code units, and joined
// with commas. A reordered or repeated selection is the same scope, so
// history and revision numbers never split.

export function scopeKeyOf(entryIds: readonly string[]): string {
  return [...new Set(entryIds)].sort().join(',');
}
