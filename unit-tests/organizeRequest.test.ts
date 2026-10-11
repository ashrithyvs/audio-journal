import { createHash, createHmac } from 'node:crypto';

import type {
  JournalEntry,
  RecordingRecord,
} from '../src/features/journal/domain/entry';
import type { TranscriptView } from '../src/features/journal/domain/transcript';
import type { JournalEntryDetail } from '../src/features/journal/ports/JournalRepository';
import {
  canonicalJson,
  inputViolation,
  INPUT_CAP,
} from '../src/features/organize/domain/contract';
import {
  buildOrganizeRequest,
  deviceContext,
  requestKeyOf,
  writtenUnits,
  type OrganizeCrypto,
} from '../src/features/organize/domain/request';

// journal.organize@1 requests (contract §2, §9): what is sent, how written
// text becomes units, refusals instead of truncation, and the opaque key.

const sha256Hex = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');
const crypto: OrganizeCrypto = {
  sha256Hex,
  hmacSha256Hex: (keyHex, label, text) =>
    createHmac('sha256', Buffer.from(keyHex, 'hex'))
      .update(
        Buffer.concat([
          Buffer.from(label, 'utf8'),
          Buffer.from([0]),
          Buffer.from(text, 'utf8'),
        ]),
      )
      .digest('hex'),
};
const KEY = 'ab'.repeat(32);
const OTHER_KEY = 'cd'.repeat(32);
const context = { locale: 'en-IN', timeZone: 'Asia/Kolkata' };
const id = (prefix: string, n: number) =>
  `${prefix}_${String(n).padStart(26, '0')}`;

function written(n: number, text: string, extra: Partial<JournalEntry> = {}) {
  const entry: JournalEntry = {
    id: id('ent', n),
    kind: 'written',
    status: 'ready',
    createdAt: 1_760_000_000_000 + n * 1000,
    updatedAt: 1_760_000_000_000 + n * 1000,
    sourceText: text,
    ...extra,
  };
  return {
    entry,
    transcript: { kind: 'none', engineRevision: 0, lines: [] },
  } as JournalEntryDetail;
}

function voice(
  n: number,
  lines: string[],
  options: {
    state?: RecordingRecord['state'];
    kind?: TranscriptView['kind'];
  } = {},
): JournalEntryDetail {
  const recording: RecordingRecord = {
    id: id('rec', n),
    entryId: id('ent', n),
    relativePath: `recordings/${id('rec', n)}.ajr`,
    state: options.state ?? 'ready',
    format: 'AJR1/pcm_s16le/16000/1',
    startedAt: 1_760_000_000_000,
    durationMs: lines.length * 4000 + 500,
    sealedChunks: 3,
    byteCount: 1234,
    contentSha256: 'f'.repeat(64),
  };
  return {
    entry: {
      id: id('ent', n),
      kind: 'voice',
      status: 'ready',
      createdAt: 1_760_000_000_000 + n * 1000,
      updatedAt: 1_760_000_000_000 + n * 1000,
      title: 'Private title',
    },
    recording,
    transcript: {
      kind: options.kind ?? 'final',
      engineRevision: 2,
      modelId: 'whisper-test',
      lines: lines.map((text, i) => ({
        segmentId: id('seg', n * 100 + i),
        originSegmentId: id('seg', n * 100 + i),
        ordinal: i,
        startMs: i * 4000,
        endMs: (i + 1) * 4000,
        text,
        state: 'final',
        engineRevision: 2,
      })),
    },
  };
}

const build = (
  selection: JournalEntryDetail[],
  extra: Partial<Parameters<typeof buildOrganizeRequest>[0]> = {},
) =>
  buildOrganizeRequest({ selection, keyHex: KEY, crypto, context, ...extra });

describe('written units (§2)', () => {
  it('splits at blank lines and keeps exact offsets', () => {
    const text =
      '  First paragraph.\nstill first\n\n \t \nSecond one.  \n\n\n\tThird.';
    const units = writtenUnits(text);
    expect(units.map(u => u.text)).toEqual([
      'First paragraph.\nstill first',
      'Second one.',
      'Third.',
    ]);
    for (const unit of units) {
      expect(text.slice(unit.offset, unit.offset + unit.text.length)).toBe(
        unit.text,
      );
    }
  });

  it('splits a long paragraph at the last sentence end inside 4,000', () => {
    const sentence = 'Word '.repeat(19) + 'end. '; // 100 code units
    const text = sentence.repeat(45).trim(); // 4,499 code units
    const units = writtenUnits(text);
    // The 40th sentence ends at 3,999; its following space is dropped.
    expect(units.map(u => u.text.length)).toEqual([3999, 499]);
    expect(units[0].text.endsWith('end.')).toBe(true);
    for (const unit of units) {
      expect(text.slice(unit.offset, unit.offset + unit.text.length)).toBe(
        unit.text,
      );
    }
  });

  it('cuts at 4,000 without splitting a surrogate pair', () => {
    const text = 'a'.repeat(3999) + '😀' + 'b'.repeat(10);
    const units = writtenUnits(text);
    expect(units.map(u => u.text.length)).toEqual([3999, 12]);
    expect(units[1].text.startsWith('😀')).toBe(true);
  });

  it('drops whitespace-only pieces', () => {
    expect(writtenUnits(' \n\n\t\n  ')).toEqual([]);
  });
});

describe('building a request', () => {
  it('sends finalized text in contract order and passes the node checks', () => {
    const built = build([voice(2, ['Plan the trip.']), written(1, 'Hello.')]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.input.entries.map(e => e.entryId)).toEqual([
      id('ent', 1),
      id('ent', 2),
    ]);
    expect(inputViolation(built.input, sha256Hex)).toBeNull();
    expect(built.inputSha256).toBe(sha256Hex(canonicalJson(built.input)));
    const voiceEntry = built.input.entries[1];
    expect(voiceEntry).toMatchObject({
      kind: 'voice',
      recordingId: id('rec', 2),
      transcriptRevision: 2,
      units: [{ unitId: id('seg', 200), startMs: 0, endMs: 4000 }],
    });
  });

  it('sends no audio, paths, titles, model, or recording digests', () => {
    const built = build([voice(2, ['Plan the trip.'])]);
    if (!built.ok) throw new Error('not built');
    const text = canonicalJson(built.input);
    for (const secret of [
      'recordings/',
      '.ajr',
      'Private title',
      'whisper-test',
      'f'.repeat(64),
      KEY,
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(Object.keys(built.input.entries[0]).sort()).toEqual([
      'createdAt',
      'durationMs',
      'entryId',
      'kind',
      'recordingId',
      'transcriptRevision',
      'units',
    ]);
  });

  it('leaves out entries without finalized text and reports them', () => {
    const built = build([
      written(1, 'Kept.'),
      voice(2, ['Live only'], { kind: 'provisional' }),
      voice(3, [], { kind: 'empty' }),
      voice(4, ['Not sealed'], { state: 'recoverable' }),
      written(5, '   '),
      written(6, 'Deleted.', { status: 'deleted' }),
    ]);
    if (!built.ok) throw new Error('not built');
    expect(built.included).toEqual([id('ent', 1)]);
    expect(built.excluded).toEqual([
      { entryId: id('ent', 2), reason: 'no_transcript' },
      { entryId: id('ent', 3), reason: 'empty_transcript' },
      { entryId: id('ent', 4), reason: 'not_ready' },
      { entryId: id('ent', 5), reason: 'no_text' },
      { entryId: id('ent', 6), reason: 'not_ready' },
    ]);
  });

  it('refuses instead of truncating or rewriting', () => {
    expect(build([voice(1, [], { kind: 'none' })])).toMatchObject({
      ok: false,
      reason: 'NOTHING_TO_ORGANIZE',
    });
    expect(
      build(Array.from({ length: 21 }, (_, n) => written(n + 1, 'x'))),
    ).toMatchObject({ ok: false, reason: 'TOO_MANY_ENTRIES' });
    expect(
      build([written(1, Array.from({ length: 401 }, () => 'p').join('\n\n'))]),
    ).toMatchObject({ ok: false, reason: 'TOO_MANY_UNITS' });
    const large = build([
      written(
        1,
        Array.from({ length: 16 }, () => 'y'.repeat(3990)).join('\n\n'),
      ),
    ]);
    expect(large).toMatchObject({ ok: false, reason: 'TOO_LARGE' });
    expect(build([written(1, 'Line\r\nbreak')])).toMatchObject({
      ok: false,
      reason: 'UNSENDABLE_TEXT',
      entryId: id('ent', 1),
    });
    expect(build([written(1, 'Bidi ‮ text')])).toMatchObject({
      ok: false,
      reason: 'UNSENDABLE_TEXT',
    });
  });

  it('fits a request at the input cap', () => {
    const built = build([
      written(
        1,
        Array.from({ length: 14 }, () => 'z'.repeat(3990)).join('\n\n'),
      ),
    ]);
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.bytes).toBeLessThanOrEqual(INPUT_CAP);
  });
});

describe('the request key (§9)', () => {
  const base = () => [written(1, 'Call Priya.'), voice(2, ['Book tickets.'])];

  it('is stable for an identical request and opaque', () => {
    const a = build(base());
    const b = build(base());
    if (!a.ok || !b.ok) throw new Error('not built');
    expect(a.input.requestKey).toBe(b.input.requestKey);
    expect(a.input.requestKey).toMatch(/^org_[0-9a-hjkmnp-tv-z]{26}$/);
    // Keyed: without the device secret, the key cannot be recomputed.
    const elsewhere = build(base(), { keyHex: OTHER_KEY });
    if (!elsewhere.ok) throw new Error('not built');
    expect(elsewhere.input.requestKey).not.toBe(a.input.requestKey);
    expect(requestKeyOf(a.input, KEY, crypto)).toBe(a.input.requestKey);
  });

  it('changes whenever the request changes', () => {
    const reference = build(base());
    if (!reference.ok) throw new Error('not built');
    const variants = [
      build([written(1, 'Call Priya!'), voice(2, ['Book tickets.'])]),
      build([written(1, 'Call Priya.')]),
      build(base(), { kinds: ['tasks'] }),
      build(base(), { context: { locale: 'en-US', timeZone: 'Asia/Kolkata' } }),
      build(base(), { context: { locale: 'en-IN', timeZone: 'UTC' } }),
    ];
    const keys = variants.map(v => (v.ok ? v.input.requestKey : 'refused'));
    expect(new Set([reference.input.requestKey, ...keys]).size).toBe(6);
  });
});

describe('device context', () => {
  it('reduces locale and time zone to the contract patterns', () => {
    expect(
      deviceContext(() => ({ locale: 'en-Latn-IN', timeZone: 'Asia/Kolkata' })),
    ).toEqual({ locale: 'en-IN', timeZone: 'Asia/Kolkata' });
    expect(
      deviceContext(() => ({ locale: 'de', timeZone: 'Etc/GMT+5' })),
    ).toEqual({ locale: 'de', timeZone: 'Etc/GMT+5' });
    expect(
      deviceContext(() => ({ locale: 'x-private', timeZone: '../etc' })),
    ).toEqual({ locale: 'und', timeZone: 'UTC' });
    expect(
      deviceContext(() => {
        throw new Error('no Intl');
      }),
    ).toEqual({ locale: 'und', timeZone: 'UTC' });
  });
});
