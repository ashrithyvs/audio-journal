// Organize performance fixtures (the AJ-2 organize performance suite):
// deterministic, finalized voice-journal transcripts of a given speaking time.
// Duration is only a label. The SDK's input dimension is the request's UTF-8
// byte size, which the runner records for every fixture together with the
// word and segment counts. The text is synthetic diary speech; it is never
// stored in the journal.

import type { JournalEntryDetail } from '../../journal/ports/JournalRepository';

/** Conversational diary speech: words per minute and engine segment length. */
export const SPEECH = {
  wordsPerMinute: 140,
  minSegmentMs: 4_000,
  maxSegmentMs: 9_000,
} as const;

/** Each run replaces the digits, so runs differ while sizes stay equal. */
export const RUN_TOKEN = 'Run 0000.';

export const DURATIONS = [
  { id: 'v30s', label: '30 s', durationMs: 30_000 },
  { id: 'v1m', label: '1 min', durationMs: 60_000 },
  { id: 'v3m', label: '3 min', durationMs: 180_000 },
  { id: 'v5m', label: '5 min', durationMs: 300_000 },
  { id: 'v10m', label: '10 min', durationMs: 600_000 },
  { id: 'v30m', label: '30 min', durationMs: 1_800_000 },
  { id: 'v60m', label: '60 min', durationMs: 3_600_000 },
] as const;

const SENTENCES = [
  'Morning stand-up with the design team about Project Atlas went long.',
  'I need to send the revised budget to Priya before Friday.',
  'After work I want to call Mom about the birthday dinner.',
  'What if we tried pairing on the hard bugs every Thursday.',
  'Remember to book the dentist appointment for next week.',
  'The client review of the quarterly report went better than expected.',
  'I have to finish the onboarding slides before the sprint demo.',
  'Long walk with Arjun in the park this evening, it was calm.',
  'We should plan the Goa trip for December with the cousins.',
  'Need to renew the car insurance this week.',
  'Idea: a weekend reading club for the neighbourhood.',
  'The Harbor launch slipped again because of the vendor contract.',
  'Make sure the expense claims go in before the month closes.',
  'Zoe suggested a quieter office layout and I think she is right.',
  'Do not forget to water the plants on the balcony.',
  'Lunch was quick, mostly thinking about the hiring plan.',
  'It rained most of the afternoon and the commute was slow.',
  'I should write down three things that went well today.',
  'Maybe we could automate the weekly status email.',
  'Pick up groceries and the dry cleaning on the way home.',
];

/** Deterministic PRNG (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0; // eslint-disable-line no-bitwise
  return () => {
    /* eslint-disable no-bitwise */
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    /* eslint-enable no-bitwise */
  };
}

/** A valid local ID: prefix, a fixture letter, then a padded number. */
const localId = (prefix: string, letter: string, n: number) =>
  `${prefix}_${letter}${String(n).padStart(25, '0')}`;

export interface TranscriptFixture {
  id: string;
  label: string;
  durationMs: number;
  words: number;
  segments: number;
  detail: JournalEntryDetail;
}

/** A finalized transcript of `durationMs` speaking time. */
export function transcriptFixture(
  id: string,
  label: string,
  durationMs: number,
  letter = 'b',
): TranscriptFixture {
  const next = random(durationMs);
  const words: string[] = RUN_TOKEN.split(' ');
  const wordStream = () => {
    if (words.length === 0) {
      words.push(
        ...SENTENCES[Math.floor(next() * SENTENCES.length)].split(' '),
      );
    }
    return words.shift() as string;
  };
  const entryId = localId('ent', letter, 1);
  const recordingId = localId('rec', letter, 1);
  const lines: JournalEntryDetail['transcript']['lines'] = [];
  let at = 0;
  let total = 0;
  while (at < durationMs) {
    const span =
      SPEECH.minSegmentMs +
      Math.floor(next() * (SPEECH.maxSegmentMs - SPEECH.minSegmentMs));
    const end = Math.min(durationMs, at + span);
    const count = Math.max(
      1,
      Math.round(((end - at) / 60_000) * SPEECH.wordsPerMinute),
    );
    const text = Array.from({ length: count }, wordStream).join(' ');
    total += count;
    const segmentId = localId('seg', letter, lines.length + 1);
    lines.push({
      segmentId,
      originSegmentId: segmentId,
      ordinal: lines.length,
      startMs: at,
      endMs: end,
      text,
      state: 'final',
      engineRevision: 1,
    });
    at = end;
  }
  const createdAt = Date.parse('2026-10-01T08:00:00.000Z');
  return {
    id,
    label,
    durationMs,
    words: total,
    segments: lines.length,
    detail: {
      entry: {
        id: entryId,
        kind: 'voice',
        status: 'ready',
        createdAt,
        updatedAt: createdAt,
      },
      recording: {
        id: recordingId,
        entryId,
        relativePath: `recordings/${recordingId}.ajr`,
        state: 'ready',
        format: 'AJR1/pcm_s16le/16000/1',
        startedAt: createdAt,
        endedAt: createdAt + durationMs,
        durationMs,
        sealedChunks: Math.ceil(durationMs / 1_000),
        byteCount: durationMs * 32,
      },
      transcript: { kind: 'final', engineRevision: 1, lines },
    },
  };
}

/** The duration fixtures, in order. */
export function durationFixtures(): TranscriptFixture[] {
  return DURATIONS.map(({ id, label, durationMs }) =>
    transcriptFixture(id, label, durationMs),
  );
}

/** A copy whose run token carries `run`; sizes are unchanged. */
export function forRun(
  detail: JournalEntryDetail,
  run: number,
): JournalEntryDetail {
  const [first, ...rest] = detail.transcript.lines;
  const token = `Run ${String(run % 10_000).padStart(4, '0')}.`;
  return {
    ...detail,
    transcript: {
      ...detail.transcript,
      lines: [
        { ...first, text: first.text.replace(RUN_TOKEN, token) },
        ...rest,
      ],
    },
  };
}

/**
 * Pads or trims the last segment's text so the built request measures
 * exactly `target` bytes (`measure` builds it). ASCII text, one byte each.
 */
export function sizedTo(
  detail: JournalEntryDetail,
  target: number,
  measure: (detail: JournalEntryDetail) => number,
): JournalEntryDetail {
  let current = detail;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const diff = target - measure(current);
    if (diff === 0) {
      return current;
    }
    const lines = [...current.transcript.lines];
    const last = lines[lines.length - 1];
    const text =
      diff > 0
        ? last.text + ' word'.repeat(Math.ceil(diff / 5)).slice(0, diff)
        : last.text.slice(0, last.text.length + diff);
    lines[lines.length - 1] = { ...last, text: text.trimEnd() || 'word' };
    current = { ...current, transcript: { ...current.transcript, lines } };
  }
  throw new Error('fixture could not be sized');
}
