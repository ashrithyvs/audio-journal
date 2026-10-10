// "Empty journal" for restore (ADR-017, owner decision 2026-10-10;
// backup-and-restore.md §2). Native activation checks the same rule again
// before it replaces anything.

export interface RestoreTargetCounts {
  readyEntries: number;
  needsAttentionEntries: number;
  /** Ready or recoverable recordings: audio the user could play. */
  playableRecordings: number;
  /** Tombstones, abandoned drafts, and failed recording rows. */
  hiddenRows: number;
  /** Failed or unknown recording files and quarantined leftovers. */
  leftoverFiles: number;
}

export type RestoreTargetAssessment =
  | { allowed: true; discard: { rows: number; files: number } }
  | { allowed: false; reason: 'JOURNAL_NOT_EMPTY' };

/**
 * Restore is allowed only without visible journal content. Hidden leftovers
 * do not block it: they are counted for the confirmation screen and
 * discarded with the old journal when activation completes.
 */
export function assessRestoreTarget(
  counts: RestoreTargetCounts,
): RestoreTargetAssessment {
  if (
    counts.readyEntries > 0 ||
    counts.needsAttentionEntries > 0 ||
    counts.playableRecordings > 0
  ) {
    return { allowed: false, reason: 'JOURNAL_NOT_EMPTY' };
  }
  return {
    allowed: true,
    discard: { rows: counts.hiddenRows, files: counts.leftoverFiles },
  };
}
