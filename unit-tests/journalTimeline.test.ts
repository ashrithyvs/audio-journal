import {
  ENTRY_LIMITS,
  isSha256Hex,
  validateTitle,
  validateWrittenText,
} from '../src/features/journal/domain/entry';
import {
  excerptOf,
  groupTimeline,
  localDayKey,
  type TimelineEntry,
} from '../src/features/journal/domain/timeline';

const utcDay = (timestamp: number) =>
  new Date(timestamp).toISOString().slice(0, 10);
const DAY = 86_400_000;
const T = Date.UTC(2026, 9, 8, 12);

const entry = (
  id: string,
  createdAt: number,
  status: TimelineEntry['status'] = 'ready',
): TimelineEntry => ({ id, kind: 'written', status, createdAt });

describe('diary timeline', () => {
  it('orders newest first and groups by local day', () => {
    const sections = groupTimeline(
      [
        entry('a', T - DAY),
        entry('b', T),
        entry('c', T + 1_000),
        entry('d', T - DAY + 5),
      ],
      utcDay,
    );
    expect(sections).toEqual([
      { dayKey: '2026-10-08', entries: [entry('c', T + 1_000), entry('b', T)] },
      {
        dayKey: '2026-10-07',
        entries: [entry('d', T - DAY + 5), entry('a', T - DAY)],
      },
    ]);
  });

  it('breaks timestamp ties by ID so paging is stable', () => {
    const sections = groupTimeline(
      [entry('a', T), entry('c', T), entry('b', T)],
      utcDay,
    );
    expect(sections[0].entries.map(item => item.id)).toEqual(['c', 'b', 'a']);
  });

  it('hides drafts and deleted entries but shows recovery-required ones', () => {
    const sections = groupTimeline(
      [
        entry('draft', T, 'draft'),
        entry('gone', T, 'deleted'),
        entry('damaged', T, 'recovery_required'),
      ],
      utcDay,
    );
    expect(sections[0].entries.map(item => item.id)).toEqual(['damaged']);
  });

  it('formats a local day key', () => {
    expect(localDayKey(new Date(2026, 0, 5, 23, 59).getTime())).toBe(
      '2026-01-05',
    );
  });

  it('builds a bounded single-line excerpt', () => {
    expect(excerptOf('  two\n\nlines ')).toBe('two lines');
    const long = excerptOf('word '.repeat(100));
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('entry validators', () => {
  it('keeps written source text exactly, rejecting only empty or oversized text', () => {
    expect(validateWrittenText('  spaced\n text ')).toEqual({
      ok: true,
      text: '  spaced\n text ',
    });
    expect(validateWrittenText(' \n\t')).toEqual({
      ok: false,
      reason: 'EMPTY',
    });
    expect(
      validateWrittenText('x'.repeat(ENTRY_LIMITS.maxWrittenChars + 1)),
    ).toEqual({
      ok: false,
      reason: 'TOO_LONG',
    });
  });

  it('normalizes optional titles', () => {
    expect(validateTitle(undefined)).toEqual({ ok: true });
    expect(validateTitle('   ')).toEqual({ ok: true });
    expect(validateTitle(' A  day ')).toEqual({ ok: true, title: 'A day' });
    expect(validateTitle('x'.repeat(201))).toEqual({
      ok: false,
      reason: 'TOO_LONG',
    });
  });

  it('accepts only lower-case SHA-256 hex digests', () => {
    expect(isSha256Hex('a'.repeat(64))).toBe(true);
    expect(isSha256Hex('A'.repeat(64))).toBe(false);
    expect(isSha256Hex('a'.repeat(63))).toBe(false);
  });
});
