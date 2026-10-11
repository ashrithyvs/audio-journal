// Due dates (contract §3.3, amendment A2): explicit English phrases only,
// anchored to the entry's local creation date in the request's time zone.
// The companion's own implementation, written from the contract text; the
// app and the independent verifier each have theirs.

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
// [pattern, group of day, ordinal, month, year]
const NAMED = [
  [new RegExp(`^${DAY}(st|nd|rd|th)? ${MONTH}(?: ${YEAR})?$`), 1, 2, 3, 4],
  [new RegExp(`^${MONTH} ${DAY}(st|nd|rd|th)?(?:,? ${YEAR})?$`), 2, 3, 1, 4],
  [new RegExp(`^${DAY}(st|nd|rd|th) of ${MONTH}(?: ${YEAR})?$`), 1, 2, 3, 4],
];

function ordinalSuffix(d) {
  if (d % 100 >= 11 && d % 100 <= 13) return 'th';
  return { 1: 'st', 2: 'nd', 3: 'rd' }[d % 10] ?? 'th';
}

/** The phrase's rule and value, or null when it is not an accepted phrase. */
export function parseDuePhrase(phrase) {
  if (/[^\x00-\x7f]/.test(phrase)) return null;
  const t = phrase.toLowerCase();
  if (t === 'today') return { rule: 'due.today' };
  if (t === 'tomorrow') return { rule: 'due.tomorrow' };
  if (WEEKDAYS.includes(t))
    return { rule: 'due.weekday', weekday: WEEKDAYS.indexOf(t) };
  for (const [re, gd, go, gm, gy] of NAMED) {
    const m = re.exec(t);
    if (!m) continue;
    const day = Number(m[gd]);
    if (m[go] !== undefined && m[go] !== ordinalSuffix(day)) return null;
    return {
      rule: 'due.named-date',
      day,
      month: MONTHS.indexOf(m[gm]) + 1,
      year: m[gy] === undefined ? null : Number(m[gy]),
    };
  }
  return null;
}

const asciiAlnum = c =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

/** §3.3 context: whole words, not qualified before, not "week" after. */
export function dueContextOk(text, start, end) {
  if (start > 0 && asciiAlnum(text.charCodeAt(start - 1))) return false;
  if (end < text.length && asciiAlnum(text.charCodeAt(end))) return false;
  const before = /([A-Za-z]+)[^A-Za-z]*$/.exec(text.slice(0, start));
  if (before && QUALIFIERS.has(before[1].toLowerCase())) return false;
  const after = /^[^A-Za-z]*([A-Za-z]+)/.exec(text.slice(end));
  if (after && after[1].toLowerCase() === 'week') return false;
  return true;
}

/** The local calendar date of an instant in an IANA time zone, or null. */
export function anchorDate(createdAt, timeZone) {
  const ms = Date.parse(createdAt);
  if (!Number.isFinite(ms)) return null;
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    }).formatToParts(new Date(ms));
  } catch {
    return null;
  }
  const get = type => Number(parts.find(p => p.type === type)?.value);
  const date = { y: get('year'), m: get('month'), d: get('day') };
  return Object.values(date).every(Number.isInteger) ? date : null;
}

const DAY_MS = 86_400_000;
const utc = ({ y, m, d }) => Date.UTC(y, m - 1, d);
const iso = ms => new Date(ms).toISOString().slice(0, 10);
/** Whether y-m-d is a real Gregorian date. */
function exists(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === m - 1 &&
    t.getUTCDate() === d
  );
}

/**
 * The due date for the phrase at [start, end) of `text`, as
 * `{date: 'YYYY-MM-DD', rule}`, or null when §3.3 gives no date.
 */
export function deriveDue(text, start, end, createdAt, timeZone) {
  if (!(start >= 0 && start < end && end <= text.length)) return null;
  if (!dueContextOk(text, start, end)) return null;
  const phrase = parseDuePhrase(text.slice(start, end));
  if (!phrase) return null;
  const anchor = anchorDate(createdAt, timeZone);
  if (!anchor) return null;
  const a = utc(anchor);
  let due;
  if (phrase.rule === 'due.today') due = a;
  else if (phrase.rule === 'due.tomorrow') due = a + DAY_MS;
  else if (phrase.rule === 'due.weekday') {
    // getUTCDay: 0 Sunday … 6 Saturday; ours: 0 Monday … 6 Sunday.
    const today = (new Date(a).getUTCDay() + 6) % 7;
    due = a + ((phrase.weekday - today + 7) % 7) * DAY_MS;
  } else if (phrase.year !== null) {
    if (!exists(phrase.year, phrase.month, phrase.day)) return null;
    due = utc({ y: phrase.year, m: phrase.month, d: phrase.day });
  } else {
    for (let y = anchor.y; y <= anchor.y + 8 && due === undefined; y += 1) {
      if (!exists(y, phrase.month, phrase.day)) continue;
      const candidate = utc({ y, m: phrase.month, d: phrase.day });
      if (candidate >= a) due = candidate;
    }
    if (due === undefined) return null;
  }
  return { date: iso(due), rule: phrase.rule };
}

// ------------------------------------------------------------- engine choice

const DATE_LIKE = new RegExp(
  [
    `\\b(?:${WEEKDAYS.join('|')})s?\\b`,
    '\\b(?:today|tomorrow|tonight|yesterday|weekend|noon|midnight)\\b',
    `\\b(?:${MONTHS.join(
      '|',
    )}|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\\b`,
    '\\b\\d{1,4}[/.-]\\d{1,2}(?:[/.-]\\d{1,4})?\\b',
    '\\b\\d{1,2}(?::\\d{2})?\\s?(?:am|pm)\\b',
    '\\b\\d{1,2}:\\d{2}\\b',
  ].join('|'),
  'gi',
);
const CANDIDATES = new RegExp(
  [
    `\\b(?:today|tomorrow|${WEEKDAYS.join('|')})\\b`,
    `\\b\\d{1,2}(?:st|nd|rd|th)? of (?:${MONTHS.join('|')})(?: \\d{4})?\\b`,
    `\\b\\d{1,2}(?:st|nd|rd|th)? (?:${MONTHS.join('|')})(?: \\d{4})?\\b`,
    `\\b(?:${MONTHS.join('|')}) \\d{1,2}(?:st|nd|rd|th)?(?:,? \\d{4})?\\b`,
  ].join('|'),
  'gi',
);

/**
 * `aj.rules`' choice (§3.3): a date only when the text between `from` and
 * `to` holds exactly one date-like word, and it is an accepted, unqualified
 * phrase. Returns `{date, rule, start, end}` or null.
 */
export function findDue(text, from, to, createdAt, timeZone) {
  const span = text.slice(from, to);
  if ((span.match(DATE_LIKE) ?? []).length !== 1) return null;
  const found = [...span.matchAll(CANDIDATES)];
  if (found.length !== 1) return null;
  const start = from + found[0].index;
  const end = start + found[0][0].length;
  const due = deriveDue(text, start, end, createdAt, timeZone);
  return due ? { ...due, start, end } : null;
}
