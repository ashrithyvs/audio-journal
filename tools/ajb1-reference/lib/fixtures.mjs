// Deterministic inputs for AJB1 vectors. Every "random" value is a SHA-256
// counter stream over a label, so another implementation can rebuild each
// archive byte for byte from vectors.json:
//   stream(label, n) = first n bytes of
//     SHA-256(utf8("ajb1-vectors-v1:" + label) || u32be(0)) ||
//     SHA-256(utf8("ajb1-vectors-v1:" + label) || u32be(1)) || ...
/* eslint-disable no-bitwise -- base32 encoding is bit packing. */

import { createHash } from 'node:crypto';

export function stream(label, length) {
  const blocks = [];
  for (let counter = 0; blocks.length * 32 < length; counter += 1) {
    const index = Buffer.alloc(4);
    index.writeUInt32BE(counter);
    blocks.push(
      createHash('sha256')
        .update(Buffer.from(`ajb1-vectors-v1:${label}`, 'utf8'))
        .update(index)
        .digest(),
    );
  }
  return Buffer.concat(blocks).subarray(0, length);
}

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Same encoding as the app's newLocalId: 16 bytes as 26 base32 chars. */
export function localId(prefix, label) {
  const bytes = stream(`id:${label}`, 16);
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  out += ALPHABET[(buffer << (5 - bits)) & 31];
  return `${prefix}_${out}`;
}

export function randomInputs(label) {
  return {
    salt: stream(`${label}:salt`, 16),
    dek: stream(`${label}:dek`, 32),
    noncePrefix: stream(`${label}:nonce-prefix`, 4),
    wrapNonce: stream(`${label}:wrap-nonce`, 12),
  };
}

const sha256 = data => createHash('sha256').update(data).digest('hex');

/** PCM bytes for a recording: the counter stream of "pcm:<label>". */
export function pcmFor(label, bytes) {
  return stream(`pcm:${label}`, bytes);
}

const T0 = 1_760_000_000_000; // 2025-10-09T08:53:20Z

export function writtenFixture() {
  const records = [
    {
      t: 'entry',
      id: localId('ent', 'written-1'),
      kind: 'written',
      status: 'ready',
      createdAtMs: T0,
      updatedAtMs: T0,
      title: 'Morning pages',
      sourceText: 'Walked by the river.\n\tThe light was gold.  ',
    },
    {
      // Combining marks (NFD), a ZWJ emoji, Arabic, an em dash, and a BEL
      // control: preserved exactly, escaped only as JCS requires.
      t: 'entry',
      id: localId('ent', 'written-2'),
      kind: 'written',
      status: 'ready',
      createdAtMs: T0 + 60_000,
      updatedAtMs: T0 + 61_000,
      sourceText:
        'Cafe\u0301 ☕ — \u{1F469}\u200d\u{1F4BB} مرحبا \u0007bell "quoted" back\\slash',
    },
  ];
  return { records, pcm: new Map(), pcmLabels: new Map() };
}

/** Voice entries whose plaintext spans `segments` full segments plus a final. */
export function voiceFixture({ longMs = 66_000 } = {}) {
  const v1 = localId('ent', 'voice-1');
  const v2 = localId('ent', 'voice-2');
  const r1 = localId('rec', 'recording-1');
  const r2 = localId('rec', 'recording-2');
  const pcm = new Map([
    [r1, pcmFor('recording-1', longMs * 32)],
    [r2, pcmFor('recording-2', 250 * 32)],
  ]);
  const pcmLabels = new Map([
    [r1, 'recording-1'],
    [r2, 'recording-2'],
  ]);
  const seg = label => localId('seg', label);
  const records = [
    ...writtenFixture().records.slice(0, 1),
    {
      t: 'entry',
      id: v1,
      kind: 'voice',
      status: 'ready',
      createdAtMs: T0 + 120_000,
      updatedAtMs: T0 + 190_000,
      title: 'Walk home',
    },
    {
      t: 'entry',
      id: v2,
      kind: 'voice',
      status: 'recovery_required',
      createdAtMs: T0 + 300_000,
      updatedAtMs: T0 + 300_250,
    },
    {
      t: 'recording',
      id: r1,
      entryId: v1,
      state: 'ready',
      startedAtMs: T0 + 120_000,
      endedAtMs: T0 + 120_000 + longMs,
      durationMs: longMs,
      pcmBytes: longMs * 32,
      pcmSha256: sha256(pcm.get(r1)),
      finishReason: 'user',
    },
    {
      t: 'recording',
      id: r2,
      entryId: v2,
      state: 'recoverable',
      startedAtMs: T0 + 300_000,
      durationMs: 250,
      pcmBytes: 250 * 32,
      pcmSha256: sha256(pcm.get(r2)),
    },
    ...[
      [0, 0, 9_000, 'I walked home along the canal.'],
      [1, 9_000, 21_000, 'Need to call the landlord tomorow.'],
      [2, 21_000, longMs - 500, 'It was quiet.'],
    ].map(([ordinal, startMs, endMs, text]) => ({
      t: 'transcriptSegment',
      id: seg(`r1-final-${ordinal}`),
      entryId: v1,
      recordingId: r1,
      engineRevision: 1,
      ordinal,
      startMs,
      endMs,
      text,
      state: 'final',
      source: 'engine',
      modelId: 'base.en-q5_1',
      createdAtMs: T0 + 200_000,
    })),
    {
      t: 'transcriptSegment',
      id: seg('r1-correction-1'),
      entryId: v1,
      recordingId: r1,
      engineRevision: 1,
      ordinal: 1,
      startMs: 9_000,
      endMs: 21_000,
      text: 'Need to call the landlord tomorrow.',
      state: 'corrected',
      source: 'user',
      supersedesSegmentId: seg('r1-final-1'),
      createdAtMs: T0 + 400_000,
    },
    {
      t: 'transcriptSegment',
      id: seg('r1-correction-2'),
      entryId: v1,
      recordingId: r1,
      engineRevision: 1,
      ordinal: 1,
      startMs: 9_000,
      endMs: 21_000,
      text: 'Need to call the landlord tomorrow morning.',
      state: 'corrected',
      source: 'user',
      supersedesSegmentId: seg('r1-correction-1'),
      createdAtMs: T0 + 500_000,
    },
    {
      // Live text only: recording 2 never got a full pass.
      t: 'transcriptSegment',
      id: seg('r2-live-0'),
      entryId: v2,
      recordingId: r2,
      engineRevision: 0,
      ordinal: 0,
      startMs: 0,
      endMs: 240,
      text: 'Hel',
      state: 'provisional',
      source: 'engine',
      createdAtMs: T0 + 300_200,
    },
  ];
  return { records, pcm, pcmLabels };
}

export const CREATED_AT_MS = T0 + 600_000;
