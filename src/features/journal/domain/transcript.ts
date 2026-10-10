import type { IdSource } from './ids';

// Transcript revisions (ADR-002, ADR-017, LLD §2/§6). Rows are append-only:
// an engine pass adds a revision, a user correction adds a row that supersedes
// exactly one earlier row, and neither changes the recording or older rows.
// Engine revision 0 holds live provisional text; full passes are 1, 2, ...

export type SegmentState = 'provisional' | 'final' | 'corrected';
export type SegmentSource = 'engine' | 'user';

export interface TranscriptSegmentRecord {
  id: string;
  entryId: string;
  recordingId: string;
  engineRevision: number;
  ordinal: number;
  startMs: number;
  endMs: number;
  text: string;
  state: SegmentState;
  source: SegmentSource;
  modelId?: string;
  supersedesSegmentId?: string;
  /** Live rows only: set when a full pass or a later window replaces them. */
  supersededAt?: number;
  createdAt: number;
}

export interface RawEngineSegment {
  t0Ms: number;
  t1Ms: number;
  text: string;
}

export interface NormalizedSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export const TRANSCRIPT_LIMITS = {
  maxSegmentChars: 4_000,
  maxSegmentsPerRevision: 20_000,
  /** Live rows per recording; schema v1 enforces the same bound. */
  maxProvisionalSegments: 4_000,
  /**
   * whisper.cpp reports 10 ms steps and may end the last segment slightly past
   * the audio; overshoot up to this is clamped, beyond it is rejected.
   */
  endOvershootToleranceMs: 1_000,
} as const;

export type TranscriptRejection =
  | 'INVALID_TIME'
  | 'OUT_OF_RANGE'
  | 'OUT_OF_ORDER'
  | 'TOO_MANY_SEGMENTS'
  | 'TEXT_TOO_LONG';

// C0 controls except tab/newline, DEL, C1 controls, and bidi embeddings,
// overrides, and isolates. Zero-width joiners stay: user text may use emoji.
const UNSAFE_CHARS =
  // eslint-disable-next-line no-control-regex -- removing controls is the point.
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export function normalizeSegmentText(text: string): string {
  return text.replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim();
}

// whisper.cpp marks stretches without speech with a bracketed annotation
// ("[BLANK_AUDIO]", "[ Silence ]", "(wind blowing)"). A segment that is only
// such an annotation holds no words, so it is dropped like an empty one; the
// recording itself is unchanged.
const NON_SPEECH = /^(?:\[[^[\]]*\]|\([^()]*\))$/;

/** Whether normalized segment text holds words worth keeping. */
export function isSpokenText(normalized: string): boolean {
  return normalized !== '' && !NON_SPEECH.test(normalized);
}

/**
 * Validates one engine pass against the finalized recording duration. Empty
 * and non-speech segments are dropped; anything else malformed rejects the
 * whole pass so a partial transcript is never stored as if it were complete.
 */
export function validateEngineSegments(
  raw: readonly RawEngineSegment[],
  durationMs: number,
):
  | { ok: true; segments: NormalizedSegment[] }
  | { ok: false; reason: TranscriptRejection; index?: number } {
  if (raw.length > TRANSCRIPT_LIMITS.maxSegmentsPerRevision) {
    return { ok: false, reason: 'TOO_MANY_SEGMENTS' };
  }
  const segments: NormalizedSegment[] = [];
  let previousStart = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const { t0Ms, t1Ms, text } = raw[index];
    if (
      !Number.isInteger(t0Ms) ||
      !Number.isInteger(t1Ms) ||
      t0Ms < 0 ||
      t1Ms < t0Ms
    ) {
      return { ok: false, reason: 'INVALID_TIME', index };
    }
    if (
      t0Ms > durationMs ||
      t1Ms > durationMs + TRANSCRIPT_LIMITS.endOvershootToleranceMs
    ) {
      return { ok: false, reason: 'OUT_OF_RANGE', index };
    }
    if (t0Ms < previousStart) {
      return { ok: false, reason: 'OUT_OF_ORDER', index };
    }
    previousStart = t0Ms;
    const normalized = normalizeSegmentText(text);
    if (normalized.length > TRANSCRIPT_LIMITS.maxSegmentChars) {
      return { ok: false, reason: 'TEXT_TOO_LONG', index };
    }
    if (isSpokenText(normalized)) {
      segments.push({
        startMs: t0Ms,
        endMs: Math.min(t1Ms, durationMs),
        text: normalized,
      });
    }
  }
  return { ok: true, segments };
}

export function nextEngineRevision(
  records: readonly TranscriptSegmentRecord[],
): number {
  return (
    records.reduce(
      (latest, record) => Math.max(latest, record.engineRevision),
      0,
    ) + 1
  );
}

export function buildEngineRevision(input: {
  entryId: string;
  recordingId: string;
  modelId: string;
  engineRevision: number;
  segments: readonly NormalizedSegment[];
  createdAt: number;
  ids: IdSource;
}): TranscriptSegmentRecord[] {
  if (!Number.isInteger(input.engineRevision) || input.engineRevision < 1) {
    throw new Error('engine revisions start at 1');
  }
  return input.segments.map((segment, ordinal) => ({
    id: input.ids.next('seg'),
    entryId: input.entryId,
    recordingId: input.recordingId,
    engineRevision: input.engineRevision,
    ordinal,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
    state: 'final',
    source: 'engine',
    modelId: input.modelId,
    createdAt: input.createdAt,
  }));
}

export interface TranscriptLine {
  /** Row to cite and to correct next: the head of the correction chain. */
  segmentId: string;
  /** The engine segment the chain started from. */
  originSegmentId: string;
  ordinal: number;
  startMs: number;
  endMs: number;
  text: string;
  state: SegmentState;
  engineRevision: number;
}

export interface TranscriptView {
  /** `empty`: a full pass ran and found no speech. */
  kind: 'none' | 'provisional' | 'final' | 'empty';
  engineRevision: number;
  modelId?: string;
  lines: TranscriptLine[];
}

/**
 * The transcript to show: the newest full engine pass with corrections applied,
 * or live provisional text until a full pass exists.
 */
/** A logged full pass with no segments (for example, silence). */
export function withEmptyPass(
  view: TranscriptView,
  lastPass: { engineRevision: number; modelId: string } | undefined,
): TranscriptView {
  return view.kind === 'none' && lastPass
    ? {
        kind: 'empty',
        engineRevision: lastPass.engineRevision,
        modelId: lastPass.modelId,
        lines: [],
      }
    : view;
}

export function currentTranscript(
  records: readonly TranscriptSegmentRecord[],
): TranscriptView {
  const engineRevision = records.reduce(
    (latest, record) =>
      record.state === 'provisional'
        ? latest
        : Math.max(latest, record.engineRevision),
    0,
  );
  // Superseded live rows stay in history but are never shown.
  const scoped = records.filter(
    record =>
      record.engineRevision === engineRevision &&
      record.supersededAt === undefined,
  );
  const successor = new Map<string, TranscriptSegmentRecord>();
  for (const record of scoped) {
    if (record.supersedesSegmentId) {
      successor.set(record.supersedesSegmentId, record);
    }
  }
  // Engine ordinals follow start order; provisional rows only have times.
  const origins = scoped
    .filter(record => record.supersedesSegmentId === undefined)
    .sort(
      (left, right) =>
        left.startMs - right.startMs ||
        left.ordinal - right.ordinal ||
        left.id.localeCompare(right.id),
    );
  const lines = origins.map(origin => {
    let head = origin;
    for (
      let next = successor.get(head.id);
      next;
      next = successor.get(head.id)
    ) {
      head = next;
    }
    return {
      segmentId: head.id,
      originSegmentId: origin.id,
      ordinal: origin.ordinal,
      startMs: origin.startMs,
      endMs: origin.endMs,
      text: head.text,
      state: head.state,
      engineRevision,
    };
  });
  return {
    kind:
      lines.length === 0 ? 'none' : engineRevision ? 'final' : 'provisional',
    engineRevision,
    modelId: origins[0]?.modelId,
    lines,
  };
}

export type CorrectionRejection =
  | 'NOT_FOUND'
  | 'PROVISIONAL'
  | 'NOT_CURRENT_REVISION'
  | 'STALE'
  | 'UNCHANGED'
  | 'TEXT_TOO_LONG';

/**
 * A correction supersedes the current head of one chain (AJ-FR-012). It keeps
 * the engine segment's audio range: corrections change words, never the source.
 */
export function planCorrection(input: {
  records: readonly TranscriptSegmentRecord[];
  segmentId: string;
  text: string;
  createdAt: number;
  ids: IdSource;
}):
  | { ok: true; record: TranscriptSegmentRecord }
  | { ok: false; reason: CorrectionRejection } {
  const target = input.records.find(record => record.id === input.segmentId);
  if (!target) {
    return { ok: false, reason: 'NOT_FOUND' };
  }
  if (target.state === 'provisional') {
    return { ok: false, reason: 'PROVISIONAL' };
  }
  const view = currentTranscript(input.records);
  if (target.engineRevision !== view.engineRevision) {
    return { ok: false, reason: 'NOT_CURRENT_REVISION' };
  }
  const line = view.lines.find(item => item.segmentId === target.id);
  if (!line) {
    return { ok: false, reason: 'STALE' };
  }
  const text = normalizeSegmentText(input.text);
  if (text.length > TRANSCRIPT_LIMITS.maxSegmentChars) {
    return { ok: false, reason: 'TEXT_TOO_LONG' };
  }
  if (text === line.text) {
    return { ok: false, reason: 'UNCHANGED' };
  }
  return {
    ok: true,
    record: {
      id: input.ids.next('seg'),
      entryId: target.entryId,
      recordingId: target.recordingId,
      engineRevision: target.engineRevision,
      ordinal: target.ordinal,
      startMs: line.startMs,
      endMs: line.endMs,
      text,
      state: 'corrected',
      source: 'user',
      supersedesSegmentId: target.id,
      createdAt: input.createdAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Live provisional text (LLD §6). Window length/overlap/cadence are still Open
// (ADR-017), so this only enforces the window-independent rules: updates are
// keyed by segment ID, revisions only move forward, times stay inside the
// captured audio, and nothing is accepted once the stream is closed.

export interface ProvisionalUpdate {
  segmentId: string;
  revision: number;
  startMs: number;
  endMs: number;
  text: string;
}

export interface ProvisionalTranscript {
  closed: boolean;
  segments: Record<string, ProvisionalUpdate>;
  /** Segment IDs changed since the last flush to storage. */
  dirty: string[];
  /** Segment IDs replaced by a later window; late updates are ignored. */
  retired: string[];
  /** Retired since the last flush, to mark superseded in storage. */
  retiredDirty: string[];
  /** Every ID ever accepted, retired or not; bounded like the schema. */
  seen: number;
}

export const emptyProvisional: ProvisionalTranscript = {
  closed: false,
  segments: {},
  dirty: [],
  retired: [],
  retiredDirty: [],
  seen: 0,
};

export function applyProvisional(
  state: ProvisionalTranscript,
  update: ProvisionalUpdate,
  capturedMs: number,
): ProvisionalTranscript {
  const previous = state.segments[update.segmentId];
  if (
    state.closed ||
    state.retired.includes(update.segmentId) ||
    (!previous && state.seen >= TRANSCRIPT_LIMITS.maxProvisionalSegments) ||
    !Number.isSafeInteger(update.revision) ||
    (previous && update.revision <= previous.revision) ||
    !Number.isInteger(update.startMs) ||
    !Number.isInteger(update.endMs) ||
    update.startMs < 0 ||
    update.endMs < update.startMs ||
    update.endMs > capturedMs
  ) {
    return state;
  }
  const text = normalizeSegmentText(update.text).slice(
    0,
    TRANSCRIPT_LIMITS.maxSegmentChars,
  );
  return {
    ...state,
    segments: { ...state.segments, [update.segmentId]: { ...update, text } },
    dirty: state.dirty.includes(update.segmentId)
      ? state.dirty
      : [...state.dirty, update.segmentId],
    seen: previous ? state.seen : state.seen + 1,
  };
}

/** A later window replaced these segments; they stop showing and freeze. */
export function retireProvisional(
  state: ProvisionalTranscript,
  segmentIds: readonly string[],
): ProvisionalTranscript {
  const retiring = segmentIds.filter(
    id => state.segments[id] && !state.retired.includes(id),
  );
  if (state.closed || retiring.length === 0) {
    return state;
  }
  const segments = { ...state.segments };
  retiring.forEach(id => delete segments[id]);
  return {
    ...state,
    segments,
    dirty: state.dirty.filter(id => !retiring.includes(id)),
    retired: [...state.retired, ...retiring],
    retiredDirty: [...state.retiredDirty, ...retiring],
  };
}

/** Cancellation or the end of capture: later engine events are ignored. */
export function closeProvisional(
  state: ProvisionalTranscript,
): ProvisionalTranscript {
  return state.closed ? state : { ...state, closed: true };
}

export function orderedProvisional(
  state: ProvisionalTranscript,
): ProvisionalUpdate[] {
  return Object.values(state.segments).sort(
    (left, right) =>
      left.startMs - right.startMs ||
      left.segmentId.localeCompare(right.segmentId),
  );
}

/** Takes what to persist (bounded loss on process death) and clears it. */
export function takeDirty(state: ProvisionalTranscript): {
  state: ProvisionalTranscript;
  batch: ProvisionalUpdate[];
  retired: string[];
} {
  return {
    state: { ...state, dirty: [], retiredDirty: [] },
    batch: state.dirty.map(id => state.segments[id]),
    retired: state.retiredDirty,
  };
}
