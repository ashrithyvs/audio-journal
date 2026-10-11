// Due dates (journal-organize.md §3.3, amendment A2): the app's own parser
// and derivation. The validator re-derives every node date from its cited
// phrase, the entry's createdAt, and the request's time zone, and rejects a
// date it cannot reproduce (RESULT_DUE). Written for Hermes: no lookbehind,
// and the time zone comes from Intl.DateTimeFormat.

export type DueRule =
  | 'due.today'
  | 'due.tomorrow'
  | 'due.weekday'
  | 'due.named-date';

const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const QUALIFIERS = new Set([
  'next',
  'this',
  'last',
  'coming',
  'following',
  'every',
  'each',
  'past',
  'previous',
  'after',
  'before',
]);
const DAY = '([1-9]|[12][0-9]|3[01])';
const MONTH = `(${MONTHS.join('|')})`;
const YEAR = '([1-9][0-9]{3})';
/** [form, group of day, ordinal suffix, month, year] */
const NAMED: Array<[RegExp, number, number, number, number]> = [
  [new RegExp(`^${DAY}(st|nd|rd|th)? ${MONTH}(?: ${YEAR})?$`), 1, 2, 3, 4],
  [new RegExp(`^${MONTH} ${DAY}(st|nd|rd|th)?(?:,? ${YEAR})?$`), 2, 3, 1, 4],
  [new RegExp(`^${DAY}(st|nd|rd|th) of ${MONTH}(?: ${YEAR})?$`), 1, 2, 3, 4],
];

type Phrase =
  | { rule: 'due.today' }
  | { rule: 'due.tomorrow' }
  | { rule: 'due.weekday'; weekday: number }
  | {
      rule: 'due.named-date';
      day: number;
      month: number;
      year: number | null;
    };

function ordinalSuffix(day: number): string {
  if (day % 100 >= 11 && day % 100 <= 13) {
    return 'th';
  }
  return day % 10 === 1
    ? 'st'
    : day % 10 === 2
    ? 'nd'
    : day % 10 === 3
    ? 'rd'
    : 'th';
}

function parsePhrase(phrase: string): Phrase | null {
  for (let i = 0; i < phrase.length; i += 1) {
    if (phrase.charCodeAt(i) > 0x7f) {
      return null;
    }
  }
  const t = phrase.toLowerCase();
  if (t === 'today') {
    return { rule: 'due.today' };
  }
  if (t === 'tomorrow') {
    return { rule: 'due.tomorrow' };
  }
  if (WEEKDAYS.includes(t)) {
    return { rule: 'due.weekday', weekday: WEEKDAYS.indexOf(t) };
  }
  for (const [form, gd, go, gm, gy] of NAMED) {
    const m = form.exec(t);
    if (!m) {
      continue;
    }
    const day = Number(m[gd]);
    if (m[go] !== undefined && m[go] !== ordinalSuffix(day)) {
      return null;
    }
    return {
      rule: 'due.named-date',
      day,
      month: MONTHS.indexOf(m[gm]) + 1,
      year: m[gy] === undefined ? null : Number(m[gy]),
    };
  }
  return null;
}

const asciiAlnum = (c: number) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

function contextOk(text: string, start: number, end: number): boolean {
  if (start > 0 && asciiAlnum(text.charCodeAt(start - 1))) {
    return false;
  }
  if (end < text.length && asciiAlnum(text.charCodeAt(end))) {
    return false;
  }
  const before = /([A-Za-z]+)[^A-Za-z]*$/.exec(text.slice(0, start));
  if (before && QUALIFIERS.has(before[1].toLowerCase())) {
    return false;
  }
  const after = /^[^A-Za-z]*([A-Za-z]+)/.exec(text.slice(end));
  return !(after && after[1].toLowerCase() === 'week');
}

export interface CalendarDate {
  y: number;
  m: number;
  d: number;
}

/** The local Gregorian date of an instant in an IANA time zone, or null. */
export function localDate(ms: number, timeZone: string): CalendarDate | null {
  if (!Number.isFinite(ms)) {
    return null;
  }
  try {
    const format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    });
    let y: number;
    let m: number;
    let d: number;
    if (typeof format.formatToParts === 'function') {
      const parts = format.formatToParts(new Date(ms));
      const get = (type: string) =>
        Number(parts.find(p => p.type === type)?.value);
      [y, m, d] = [get('year'), get('month'), get('day')];
    } else {
      const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(
        format.format(new Date(ms)),
      );
      if (!match) {
        return null;
      }
      [m, d, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
    }
    return [y, m, d].every(Number.isInteger) ? { y, m, d } : null;
  } catch {
    return null;
  }
}

const DAY_MS = 86_400_000;
const utc = ({ y, m, d }: CalendarDate) => Date.UTC(y, m - 1, d);
export const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function exists(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === m - 1 &&
    t.getUTCDate() === d
  );
}

/**
 * The due date for the phrase at [start, end) of `text` (UTF-16 offsets),
 * or null when §3.3 gives no date. `createdAt` is the entry's ISO UTC time.
 */
export function deriveDue(
  text: string,
  start: number,
  end: number,
  createdAt: string,
  timeZone: string,
): { date: string; rule: DueRule } | null {
  if (!(start >= 0 && start < end && end <= text.length)) {
    return null;
  }
  if (!contextOk(text, start, end)) {
    return null;
  }
  const phrase = parsePhrase(text.slice(start, end));
  if (!phrase) {
    return null;
  }
  const anchor = localDate(Date.parse(createdAt), timeZone);
  if (!anchor) {
    return null;
  }
  const a = utc(anchor);
  let due: number | undefined;
  if (phrase.rule === 'due.today') {
    due = a;
  } else if (phrase.rule === 'due.tomorrow') {
    due = a + DAY_MS;
  } else if (phrase.rule === 'due.weekday') {
    const today = (new Date(a).getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
    due = a + ((phrase.weekday - today + 7) % 7) * DAY_MS;
  } else if (phrase.year !== null) {
    if (!exists(phrase.year, phrase.month, phrase.day)) {
      return null;
    }
    due = utc({ y: phrase.year, m: phrase.month, d: phrase.day });
  } else {
    for (let y = anchor.y; y <= anchor.y + 8 && due === undefined; y += 1) {
      if (exists(y, phrase.month, phrase.day)) {
        const candidate = utc({ y, m: phrase.month, d: phrase.day });
        if (candidate >= a) {
          due = candidate;
        }
      }
    }
    if (due === undefined) {
      return null;
    }
  }
  return { date: isoDate(due), rule: phrase.rule };
}
