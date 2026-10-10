// Local backup history (AJ1-DEC-001, option B). The AJB1 archive itself stays
// byte-frozen, so an export that skipped damaged entries is marked
// incomplete here, in its suggested file name, and on its result screen.
// History holds counts only: no IDs, titles, paths, or content.

export const BACKUP_HISTORY_KEY = 'backup.history';
const MAX_ITEMS = 10;

export interface BackupHistoryItem {
  atMs: number;
  bytes: number;
  /** Entries left out after explicit confirmation; 0 for a complete backup. */
  excludedEntries: number;
}

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

export function parseHistory(json: string | undefined): BackupHistoryItem[] {
  if (!json) {
    return [];
  }
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .filter(
        (item): item is BackupHistoryItem =>
          typeof item === 'object' &&
          item !== null &&
          isCount(item.atMs) &&
          isCount(item.bytes) &&
          isCount(item.excludedEntries),
      )
      .map(({ atMs, bytes, excludedEntries }) => ({
        atMs,
        bytes,
        excludedEntries,
      }));
  } catch {
    return [];
  }
}

export function appendHistory(
  history: readonly BackupHistoryItem[],
  item: BackupHistoryItem,
): BackupHistoryItem[] {
  return [item, ...history].slice(0, MAX_ITEMS);
}

const two = (value: number) => String(value).padStart(2, '0');

/** `AudioJournal-YYYY-MM-DD-HHMM[-incomplete].ajbackup`, in local time. */
export function suggestedFileName(atMs: number, incomplete: boolean): string {
  const at = new Date(atMs);
  const stamp = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(
    at.getDate(),
  )}-${two(at.getHours())}${two(at.getMinutes())}`;
  return `AudioJournal-${stamp}${incomplete ? '-incomplete' : ''}.ajbackup`;
}
