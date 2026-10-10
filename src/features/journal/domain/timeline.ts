import type { EntryKind, EntryStatus } from './entry';

// Diary timeline (UX §2/§7): newest first, grouped by the user's local day.
// Unorganized entries are never treated differently from organized ones.

export interface TimelineEntry {
  id: string;
  kind: EntryKind;
  status: EntryStatus;
  createdAt: number;
  title?: string;
  durationMs?: number;
  excerpt?: string;
}

export interface TimelineSection {
  dayKey: string;
  entries: TimelineEntry[];
}

/** Local calendar day as YYYY-MM-DD; injectable so tests fix the zone. */
export type DayKeyOf = (timestamp: number) => string;

export const localDayKey: DayKeyOf = timestamp => {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};

export function isTimelineVisible(status: EntryStatus): boolean {
  // Drafts are captures in progress; deleted entries are hidden.
  return status === 'ready' || status === 'recovery_required';
}

export function compareTimeline(
  left: Pick<TimelineEntry, 'createdAt' | 'id'>,
  right: Pick<TimelineEntry, 'createdAt' | 'id'>,
): number {
  return right.createdAt - left.createdAt || (left.id < right.id ? 1 : -1);
}

export function groupTimeline(
  entries: readonly TimelineEntry[],
  dayKeyOf: DayKeyOf = localDayKey,
): TimelineSection[] {
  const sections: TimelineSection[] = [];
  for (const entry of entries
    .filter(item => isTimelineVisible(item.status))
    .sort(compareTimeline)) {
    const dayKey = dayKeyOf(entry.createdAt);
    const last = sections[sections.length - 1];
    if (last?.dayKey === dayKey) {
      last.entries.push(entry);
    } else {
      sections.push({ dayKey, entries: [entry] });
    }
  }
  return sections;
}

export const EXCERPT_CHARS = 160;

export function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= EXCERPT_CHARS
    ? flat
    : `${flat.slice(0, EXCERPT_CHARS - 1).trimEnd()}…`;
}
