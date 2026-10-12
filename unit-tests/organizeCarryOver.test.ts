import {
  matchCarryOver,
  type NextTask,
  type PreviousTask,
} from '../src/features/organize/domain/carryOver';
import type { SourceRef } from '../src/features/organize/domain/contract';

// ADR-020 conservative carry-over: only proven, unambiguous, one-to-one.

const ENT_A = `ent_${'a'.repeat(26)}`;
const ENT_B = `ent_${'b'.repeat(26)}`;
const SEG_1 = `seg_${'1'.repeat(26)}`;
const SEG_1C = `seg_${'c'.repeat(26)}`; // a correction of SEG_1
const SEG_2 = `seg_${'2'.repeat(26)}`; // a new pass (re-transcription)
const SHA = (n: number) => String(n).repeat(64).slice(0, 64);

const src = (
  unitId: string,
  charStart: number,
  charEnd: number,
  sha = 1,
  entryId = ENT_A,
): SourceRef => ({
  entryId,
  unitId,
  unitSha256: SHA(sha),
  charStart,
  charEnd,
});
const prev = (
  id: string,
  ordinal: number,
  text: string,
  sources: SourceRef[],
  state: PreviousTask['state'] = 'done',
): PreviousTask => ({ id, ordinal, text, state, stateChangedAt: 5, sources });
const next = (
  ordinal: number,
  text: string,
  sources: SourceRef[],
): NextTask => ({
  ordinal,
  text,
  sources,
});
const corrections: Record<string, string> = { [SEG_1C]: SEG_1 };
const supersedes = (id: string) => corrections[id];
const carried = (p: PreviousTask[], n: NextTask[]) =>
  Object.fromEntries(
    [...matchCarryOver(p, n, supersedes)].map(([o, t]) => [o, t.id]),
  );

it('carries through the same immutable unit with overlapping ranges', () => {
  expect(
    carried(
      [prev('t1', 0, 'Call the bank', [src('w0', 0, 20)])],
      [next(0, 'call  the BANK', [src('w0', 5, 30)])],
    ),
  ).toEqual({ 0: 't1' });
});

it('carries across an explicit correction lineage (corrected line)', () => {
  expect(
    carried(
      [prev('t1', 0, 'Book the dentist', [src(SEG_1, 0, 17)])],
      [next(0, 'Book the dentist', [src(SEG_1C, 0, 26, 2)])],
    ),
  ).toEqual({ 0: 't1' });
});

it('does not carry across a re-transcription (no lineage)', () => {
  expect(
    carried(
      [prev('t1', 0, 'Book the dentist', [src(SEG_1, 0, 17)])],
      [next(0, 'Book the dentist', [src(SEG_2, 0, 17)])],
    ),
  ).toEqual({});
});

it('does not carry when written text changed (digest differs)', () => {
  expect(
    carried(
      [prev('t1', 0, 'Call the bank', [src('w0', 0, 20, 1)])],
      [next(0, 'Call the bank', [src('w0', 0, 20, 3)])],
    ),
  ).toEqual({});
});

it('does not carry across unrelated entries, texts, or ranges', () => {
  expect(
    carried(
      [
        prev('t1', 0, 'Call the bank', [src('w0', 0, 20)]),
        prev('t2', 1, 'Pay rent', [src('w1', 0, 9)]),
      ],
      [
        next(0, 'Call the bank', [src('w0', 0, 20, 1, ENT_B)]), // other entry
        next(1, 'Pay the rent', [src('w1', 0, 9)]), // other text
      ],
    ),
  ).toEqual({});
  expect(
    carried(
      [prev('t1', 0, 'Call the bank', [src('w0', 0, 10)])],
      [next(0, 'Call the bank', [src('w0', 10, 20)])], // no overlap
    ),
  ).toEqual({});
});

it('does not carry ambiguous duplicates', () => {
  // Two old tasks with the same text and unit: neither new task is unique.
  expect(
    carried(
      [
        prev('t1', 0, 'Water the plants', [src('w0', 0, 30)]),
        prev('t2', 1, 'Water the plants', [src('w0', 0, 30)], 'dismissed'),
      ],
      [next(0, 'Water the plants', [src('w0', 0, 30)])],
    ),
  ).toEqual({});
  // One old task, two new candidates: the old task is not unique.
  expect(
    carried(
      [prev('t1', 0, 'Water the plants', [src('w0', 0, 30)])],
      [
        next(0, 'Water the plants', [src('w0', 0, 30)]),
        next(1, 'Water the plants', [src('w0', 5, 25)]),
      ],
    ),
  ).toEqual({});
});

it('matches one-to-one in stable rank order when the output is reordered', () => {
  const previous = [
    prev('t1', 0, 'Call the bank', [src('w0', 0, 20)]),
    prev('t2', 1, 'Pay rent', [src('w1', 0, 9)], 'dismissed'),
  ];
  // The new revision lists the same tasks in the other order.
  const reordered = [
    next(0, 'Pay rent', [src('w1', 0, 9)]),
    next(1, 'Call the bank', [src('w0', 0, 20)]),
  ];
  expect(carried(previous, reordered)).toEqual({ 0: 't2', 1: 't1' });
  // The same pairs whatever order the input arrays come in.
  expect(carried([...previous].reverse(), [...reordered].reverse())).toEqual({
    0: 't2',
    1: 't1',
  });
});
