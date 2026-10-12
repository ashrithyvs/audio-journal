// Display formatting with tabular-friendly, locale-free numbers (timers,
// durations, transcript offsets). Dates use the platform locale.

const pad = (value: number) => String(value).padStart(2, '0');

/** `m:ss`, or `h:mm:ss` from one hour; negative or invalid input is `0:00`. */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

/** A source range such as `1:31–2:18` (UX §7 task source label). */
export function formatRange(startMs: number, endMs: number): string {
  return `${formatDuration(startMs)}–${formatDuration(endMs)}`;
}

/** Heading for a `YYYY-MM-DD` day key, e.g. "Thursday, October 8". */
export function formatDayHeading(dayKey: string): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

export function formatTimeOfDay(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** An entry's moment in a source label, e.g. "Oct 8, 9:14 PM" (UX §7). */
export function formatEntryMoment(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** The most recent live text the recording screen shows (UX §5). */
export const LIVE_TAIL_CHARS = 200;

/**
 * The end of a growing live transcript, at most `max` characters, cut at a
 * word boundary with a leading ellipsis. Bounding the box keeps Pause and
 * Finish in place however long the recording runs; the full transcript is
 * in the entry after Finish.
 */
export function liveTail(text: string, max: number = LIVE_TAIL_CHARS): string {
  if (text.length <= max) {
    return text;
  }
  const tail = text.slice(text.length - max);
  const space = tail.indexOf(' ');
  return `…${space >= 0 && space < max - 1 ? tail.slice(space + 1) : tail}`;
}
