import type {
  OrganizeOutput,
  SourceRef,
} from '../src/features/organize/domain/contract';
import { scopeKeyOf } from '../src/features/organize/domain/scope';
import {
  referenceStale,
  staleness,
  type CurrentEntry,
} from '../src/features/organize/domain/staleness';
import {
  dueLabel,
  formatCalendarDate,
  taskGroup,
} from '../src/features/organize/domain/tasks';

// ADR-020 view rules: the canonical scope, computed staleness, and the Tasks
// view's due-date groups.

const ENT_A = `ent_${'a'.repeat(26)}`;
const ENT_B = `ent_${'b'.repeat(26)}`;
const SEG_1 = `seg_${'1'.repeat(26)}`;
const SEG_2 = `seg_${'2'.repeat(26)}`;
const SHA = (n: number) => String(n).repeat(64).slice(0, 64);

const ref = (entryId: string, unitId: string, sha = 1): SourceRef => ({
  entryId,
  unitId,
  unitSha256: SHA(sha),
  charStart: 0,
  charEnd: 4,
});

describe('scopeKeyOf', () => {
  it('is the same for reordered and repeated selections', () => {
    expect(scopeKeyOf([ENT_B, ENT_A])).toBe(`${ENT_A},${ENT_B}`);
    expect(scopeKeyOf([ENT_A, ENT_B, ENT_A])).toBe(scopeKeyOf([ENT_B, ENT_A]));
    expect(scopeKeyOf([ENT_A])).not.toBe(scopeKeyOf([ENT_A, ENT_B]));
  });

  it('sorts by UTF-16 code units, not locale', () => {
    expect(scopeKeyOf(['ent_b', 'ent_B', 'ent_a'])).toBe('ent_B,ent_a,ent_b');
  });
});

describe('staleness', () => {
  const current = new Map<string, CurrentEntry>([
    [ENT_A, { ready: true, segments: new Set([SEG_1]) }],
    [ENT_B, { ready: true, writtenDigests: new Map([['w0', SHA(1)]]) }],
  ]);

  it('marks a voice reference stale once its line is no longer current', () => {
    expect(referenceStale(ref(ENT_A, SEG_1), current)).toBe(false);
    expect(referenceStale(ref(ENT_A, SEG_2), current)).toBe(true);
  });

  it('marks a written reference stale when the re-split unit digest differs', () => {
    expect(referenceStale(ref(ENT_B, 'w0', 1), current)).toBe(false);
    expect(referenceStale(ref(ENT_B, 'w0', 2), current)).toBe(true);
    expect(referenceStale(ref(ENT_B, 'w1', 1), current)).toBe(true);
  });

  it('marks references to missing or unready entries stale', () => {
    expect(referenceStale(ref('ent_gone', SEG_1), current)).toBe(true);
    const unready = new Map([[ENT_A, { ready: false }]]);
    expect(referenceStale(ref(ENT_A, SEG_1), unready)).toBe(true);
  });

  it('keys every stale item, including a task whose due source changed', () => {
    const output = {
      contract: 'journal.organize@1',
      summary: { text: 's', sources: [ref(ENT_A, SEG_1)] },
      sections: [
        {
          area: 'work',
          items: [
            { text: 'ok', sources: [ref(ENT_A, SEG_1)] },
            { text: 'old', sources: [ref(ENT_A, SEG_2)] },
          ],
        },
      ],
      tasks: [
        { text: 't0', area: 'work', sources: [ref(ENT_A, SEG_1)] },
        {
          text: 't1',
          area: 'work',
          sources: [ref(ENT_A, SEG_1)],
          due: {
            date: '2026-10-16',
            rule: 'due.weekday',
            source: ref(ENT_B, 'w0', 2),
          },
        },
      ],
      ideas: [{ text: 'i', sources: [ref(ENT_B, 'w0', 2)] }],
      people: [],
      projects: [],
    } as unknown as OrganizeOutput;
    const result = staleness(output, current);
    expect(result.stale).toBe(true);
    expect([...result.items].sort()).toEqual(['idea:0', 'task:1', 'work:1']);
  });
});

describe('Tasks view groups', () => {
  const today = '2026-10-11';

  it('groups open tasks by due date against today', () => {
    expect(taskGroup('open', '2026-10-10', today)).toBe('overdue');
    expect(taskGroup('open', '2026-10-11', today)).toBe('today');
    expect(taskGroup('open', '2026-10-12', today)).toBe('upcoming');
    expect(taskGroup('open', undefined, today)).toBe('undated');
  });

  it('keeps done and dismissed tasks in their own groups, dated or not', () => {
    expect(taskGroup('done', '2026-10-10', today)).toBe('done');
    expect(taskGroup('dismissed', undefined, today)).toBe('dismissed');
  });

  it('compares across month and year ends as calendar dates', () => {
    expect(taskGroup('open', '2026-12-31', '2027-01-01')).toBe('overdue');
    expect(taskGroup('open', '2028-02-29', '2028-02-28')).toBe('upcoming');
  });

  it('formats calendar dates without a time zone', () => {
    expect(formatCalendarDate('2026-10-23')).toBe('Fri 23 Oct 2026');
    expect(formatCalendarDate('2028-02-29')).toBe('Tue 29 Feb 2028');
    expect(dueLabel('2026-10-11', today)).toBe('Due today');
    expect(dueLabel('2026-10-09', today)).toBe('Overdue · Fri 9 Oct 2026');
    expect(dueLabel('2026-11-14', today)).toBe('Due Sat 14 Nov 2026');
  });
});
