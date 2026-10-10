import {
  applyProvisional,
  buildEngineRevision,
  closeProvisional,
  currentTranscript,
  emptyProvisional,
  nextEngineRevision,
  normalizeSegmentText,
  orderedProvisional,
  planCorrection,
  retireProvisional,
  takeDirty,
  TRANSCRIPT_LIMITS,
  validateEngineSegments,
  type TranscriptSegmentRecord,
} from '../src/features/journal/domain/transcript';
import { sequentialIds } from '../test/sqlite/journalFixtures';

const ids = sequentialIds();
const base = { entryId: 'ent_1', recordingId: 'rec_1', createdAt: 10 };

function engine(revision: number, texts: string[]): TranscriptSegmentRecord[] {
  return buildEngineRevision({
    ...base,
    modelId: 'base.en-q5_1',
    engineRevision: revision,
    segments: texts.map((text, index) => ({
      startMs: index * 1_000,
      endMs: index * 1_000 + 900,
      text,
    })),
    ids,
  });
}

function correct(records: TranscriptSegmentRecord[], id: string, text: string) {
  const plan = planCorrection({
    records,
    segmentId: id,
    text,
    createdAt: 20,
    ids,
  });
  if (!plan.ok) {
    throw new Error(plan.reason);
  }
  return [...records, plan.record];
}

describe('engine segment validation', () => {
  it('normalizes text and drops empty segments', () => {
    expect(
      validateEngineSegments(
        [
          { t0Ms: 0, t1Ms: 500, text: '  hello\n\tworld ' },
          { t0Ms: 500, t1Ms: 900, text: '   ' },
          { t0Ms: 900, t1Ms: 1_000, text: 'a\u202eb\u0007c' },
        ],
        1_000,
      ),
    ).toEqual({
      ok: true,
      segments: [
        { startMs: 0, endMs: 500, text: 'hello world' },
        { startMs: 900, endMs: 1_000, text: 'abc' },
      ],
    });
  });

  it('clamps a small end overshoot and rejects a large one', () => {
    const tolerance = TRANSCRIPT_LIMITS.endOvershootToleranceMs;
    expect(
      validateEngineSegments(
        [{ t0Ms: 0, t1Ms: 1_000 + tolerance, text: 'x' }],
        1_000,
      ),
    ).toEqual({
      ok: true,
      segments: [{ startMs: 0, endMs: 1_000, text: 'x' }],
    });
    expect(
      validateEngineSegments(
        [{ t0Ms: 0, t1Ms: 1_001 + tolerance, text: 'x' }],
        1_000,
      ),
    ).toEqual({ ok: false, reason: 'OUT_OF_RANGE', index: 0 });
  });

  it.each([
    [{ t0Ms: -1, t1Ms: 5, text: 'x' }, 'INVALID_TIME'],
    [{ t0Ms: 5, t1Ms: 4, text: 'x' }, 'INVALID_TIME'],
    [{ t0Ms: 0.5, t1Ms: 4, text: 'x' }, 'INVALID_TIME'],
    [{ t0Ms: Number.NaN, t1Ms: 4, text: 'x' }, 'INVALID_TIME'],
    [{ t0Ms: 2_000, t1Ms: 2_000, text: 'x' }, 'OUT_OF_RANGE'],
    [{ t0Ms: 0, t1Ms: 5, text: 'x'.repeat(4_001) }, 'TEXT_TOO_LONG'],
  ])('rejects the whole pass for %j', (segment, reason) => {
    expect(validateEngineSegments([segment], 1_000)).toMatchObject({
      ok: false,
      reason,
    });
  });

  it('rejects out-of-order and oversized passes', () => {
    expect(
      validateEngineSegments(
        [
          { t0Ms: 500, t1Ms: 600, text: 'b' },
          { t0Ms: 100, t1Ms: 200, text: 'a' },
        ],
        1_000,
      ),
    ).toEqual({ ok: false, reason: 'OUT_OF_ORDER', index: 1 });
    const many = Array.from(
      { length: TRANSCRIPT_LIMITS.maxSegmentsPerRevision + 1 },
      () => ({ t0Ms: 0, t1Ms: 0, text: 'x' }),
    );
    expect(validateEngineSegments(many, 1_000)).toEqual({
      ok: false,
      reason: 'TOO_MANY_SEGMENTS',
    });
  });

  it('strips control and bidi-override characters', () => {
    expect(normalizeSegmentText('\u2066a\u0000b\u2069')).toBe('ab');
  });
});

describe('transcript revisions (ADR-017)', () => {
  it('shows provisional text until the first full engine pass', () => {
    const provisional: TranscriptSegmentRecord = {
      ...base,
      id: ids.next('seg'),
      engineRevision: 0,
      ordinal: 0,
      startMs: 0,
      endMs: 800,
      text: 'live',
      state: 'provisional',
      source: 'engine',
    };
    expect(currentTranscript([provisional])).toMatchObject({
      kind: 'provisional',
      lines: [{ text: 'live', state: 'provisional' }],
    });
    const final = [provisional, ...engine(1, ['final words'])];
    expect(currentTranscript(final)).toMatchObject({
      kind: 'final',
      engineRevision: 1,
      modelId: 'base.en-q5_1',
      lines: [{ text: 'final words', state: 'final' }],
    });
    expect(currentTranscript([])).toEqual({
      kind: 'none',
      engineRevision: 0,
      modelId: undefined,
      lines: [],
    });
  });

  it('numbers engine passes and never reuses a revision', () => {
    const first = engine(1, ['a']);
    expect(nextEngineRevision([])).toBe(1);
    expect(nextEngineRevision(first)).toBe(2);
    expect(() => engine(0, ['x'])).toThrow();
  });

  it('chains corrections without changing the engine segment or its times', () => {
    const records = engine(1, ['helo', 'world']);
    const original = records[0];
    const once = correct(records, original.id, 'hello');
    const twice = correct(once, once[once.length - 1].id, 'Hello');
    const view = currentTranscript(twice);
    expect(view.lines[0]).toMatchObject({
      originSegmentId: original.id,
      segmentId: twice[twice.length - 1].id,
      text: 'Hello',
      state: 'corrected',
      startMs: original.startMs,
      endMs: original.endMs,
    });
    expect(view.lines[1].text).toBe('world');
    // The engine row is untouched and still present (append-only history).
    expect(twice.find(r => r.id === original.id)).toEqual(original);
    expect(twice.filter(r => r.source === 'user')).toHaveLength(2);
  });

  it('rejects stale, provisional, unchanged, and old-revision corrections', () => {
    const records = engine(1, ['a']);
    const corrected = correct(records, records[0].id, 'b');
    const plan = (list: TranscriptSegmentRecord[], id: string, text: string) =>
      planCorrection({ records: list, segmentId: id, text, createdAt: 1, ids });
    expect(plan(corrected, records[0].id, 'c')).toEqual({
      ok: false,
      reason: 'STALE',
    });
    expect(plan(corrected, corrected[1].id, '  b ')).toEqual({
      ok: false,
      reason: 'UNCHANGED',
    });
    expect(plan(corrected, 'seg_missing', 'c')).toEqual({
      ok: false,
      reason: 'NOT_FOUND',
    });
    expect(plan(corrected, corrected[1].id, 'x'.repeat(4_001))).toEqual({
      ok: false,
      reason: 'TEXT_TOO_LONG',
    });
    const reRun = [...corrected, ...engine(2, ['new pass'])];
    expect(plan(reRun, corrected[1].id, 'c')).toEqual({
      ok: false,
      reason: 'NOT_CURRENT_REVISION',
    });
    const provisional: TranscriptSegmentRecord = {
      ...records[0],
      id: ids.next('seg'),
      engineRevision: 0,
      state: 'provisional',
      modelId: undefined,
    };
    expect(plan([provisional], provisional.id, 'c')).toEqual({
      ok: false,
      reason: 'PROVISIONAL',
    });
  });

  it('a re-run shows the new pass and keeps earlier rows and corrections', () => {
    const first = engine(1, ['a']);
    const corrected = correct(first, first[0].id, 'z');
    const reRun = [...corrected, ...engine(2, ['b'])];
    expect(currentTranscript(reRun)).toMatchObject({
      engineRevision: 2,
      lines: [{ text: 'b', state: 'final' }],
    });
    expect(reRun.filter(record => record.engineRevision === 1)).toHaveLength(2);
  });
});

describe('live provisional stream (LLD §6)', () => {
  const update = (
    segmentId: string,
    revision: number,
    text: string,
    endMs = 900,
  ) => ({
    segmentId,
    revision,
    startMs: 0,
    endMs,
    text,
  });

  it('accepts only forward revisions inside the captured audio', () => {
    let state = applyProvisional(
      emptyProvisional,
      update('s1', 1, 'helo'),
      1_000,
    );
    state = applyProvisional(state, update('s1', 2, 'hello'), 1_000);
    state = applyProvisional(state, update('s1', 2, 'stale'), 1_000);
    state = applyProvisional(state, update('s1', 1, 'older'), 1_000);
    state = applyProvisional(state, update('s2', 1, 'future', 5_000), 1_000);
    expect(orderedProvisional(state).map(item => item.text)).toEqual(['hello']);
  });

  it('batches changes for bounded-loss persistence', () => {
    let state = applyProvisional(emptyProvisional, update('s1', 1, 'a'), 1_000);
    state = applyProvisional(state, update('s1', 2, 'b'), 1_000);
    state = applyProvisional(state, update('s2', 1, 'c'), 1_000);
    const taken = takeDirty(state);
    expect(taken.batch.map(item => item.text)).toEqual(['b', 'c']);
    expect(takeDirty(taken.state).batch).toEqual([]);
  });

  it('ignores late events after cancellation or the end of capture', () => {
    const closed = closeProvisional(
      applyProvisional(emptyProvisional, update('s1', 1, 'a'), 1_000),
    );
    expect(applyProvisional(closed, update('s1', 2, 'late'), 1_000)).toBe(
      closed,
    );
    expect(closeProvisional(closed)).toBe(closed);
  });
});

describe('live text retention and bounds', () => {
  const update = (segmentId: string, revision = 1) => ({
    segmentId,
    revision,
    startMs: 0,
    endMs: 500,
    text: segmentId,
  });

  it('hides superseded live rows from normal reads but keeps them', () => {
    const live: TranscriptSegmentRecord = {
      ...base,
      id: ids.next('seg'),
      engineRevision: 0,
      ordinal: 0,
      startMs: 0,
      endMs: 500,
      text: 'old window',
      state: 'provisional',
      source: 'engine',
      supersededAt: 9,
    };
    const current: TranscriptSegmentRecord = {
      ...live,
      id: ids.next('seg'),
      text: 'new window',
      supersededAt: undefined,
    };
    expect(currentTranscript([live, current]).lines.map(l => l.text)).toEqual([
      'new window',
    ]);
    expect(currentTranscript([live]).kind).toBe('none');
  });

  it('retires segments a later window replaced and ignores late updates for them', () => {
    let state = applyProvisional(emptyProvisional, update('a'), 1_000);
    state = applyProvisional(state, update('b'), 1_000);
    state = retireProvisional(state, ['a', 'missing']);
    expect(orderedProvisional(state).map(item => item.segmentId)).toEqual([
      'b',
    ]);
    expect(applyProvisional(state, update('a', 2), 1_000)).toBe(state);
    const taken = takeDirty(state);
    expect(taken.retired).toEqual(['a']);
    expect(taken.batch.map(item => item.segmentId)).toEqual(['b']);
    expect(takeDirty(taken.state).retired).toEqual([]);
  });

  it('accepts at most the schema bound of live segment IDs', () => {
    let state = emptyProvisional;
    for (
      let index = 0;
      index < TRANSCRIPT_LIMITS.maxProvisionalSegments;
      index += 1
    ) {
      state = applyProvisional(state, update(`s${index}`), 1_000);
    }
    expect(applyProvisional(state, update('one-more'), 1_000)).toBe(state);
    // Revising an existing segment is still allowed at the bound.
    expect(applyProvisional(state, update('s0', 2), 1_000)).not.toBe(state);
    // Retiring does not free capacity: the bound counts every ID ever seen.
    const retired = retireProvisional(state, ['s1']);
    expect(applyProvisional(retired, update('another'), 1_000)).toBe(retired);
  });

  it('rejects non-integer revisions', () => {
    expect(
      applyProvisional(
        emptyProvisional,
        { ...update('a'), revision: 1.5 },
        1_000,
      ),
    ).toBe(emptyProvisional);
  });
});
