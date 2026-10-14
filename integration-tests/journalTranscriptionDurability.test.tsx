import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';

import {
  MAX_TRANSCRIPTION_MS,
  TranscriptionController,
} from '../src/features/journal/application/TranscriptionController';
import type {
  RecordingTranscriber,
  RecordingTranscription,
} from '../src/features/journal/ports/RecordingTranscriber';
import { EntryDetailScreen } from '../src/features/journal/ui/EntryDetailScreen';
import { FakeRecordingTranscriber } from '../test/journal/FakeRecordingTranscriber';
import { journalHarness, settle } from '../test/journal/renderJournal';
import { openJournal, readyVoiceEntry } from '../test/sqlite/journalFixtures';

// AJ-RI-2 durability (GRI-2 AJ row): recordings stay durable and recoverable
// across SDK failure, cancellation, lock, and process death; nothing but a
// valid completed result is stored, and every recoverable outcome can be
// retried. The SDK side of each path is covered on device.

const flush = () => new Promise(resolve => setImmediate(resolve));
const MODEL = 'sdk.whisper.tiny-en-q5-1_1.0.0';
type Journal = Awaited<ReturnType<typeof openJournal>>;

/** Each request stays pending until the test resolves it; cancel only records. */
class ManualTranscriber implements RecordingTranscriber {
  calls: string[] = [];
  private readonly pending: ((result: RecordingTranscription) => void)[] = [];

  transcribe(request: { requestId: string; recordingId: string }) {
    this.calls.push(`transcribe ${request.recordingId}`);
    return new Promise<RecordingTranscription>(resolve =>
      this.pending.push(resolve),
    );
  }

  cancel(requestId: string) {
    this.calls.push(`cancel ${requestId}`);
  }

  resolve(result: Partial<RecordingTranscription>) {
    this.pending.shift()?.({
      status: 'ok',
      modelId: MODEL,
      segments: [],
      ...result,
    });
  }
}

async function recordingUnchanged(context: Journal, entryId: string) {
  expect((await context.journal.getEntry(entryId))?.recording).toMatchObject({
    state: 'ready',
  });
}

describe('AJ-RI-2 transcription durability', () => {
  let context: Journal;

  beforeEach(async () => {
    context = await openJournal();
  });

  afterEach(async () => {
    await context.db.close();
  });

  it('refuses recordings over 180 s without sending them, and never retries', async () => {
    const engine = new FakeRecordingTranscriber();
    const transcription = new TranscriptionController({
      transcriber: engine,
      transcripts: context.transcripts,
      now: () => 1,
    });
    const long = await readyVoiceEntry(context, MAX_TRANSCRIPTION_MS + 1);
    const limit = await readyVoiceEntry(context, MAX_TRANSCRIPTION_MS);
    transcription.request(long.recordingId, MAX_TRANSCRIPTION_MS + 1);
    transcription.request(long.recordingId, MAX_TRANSCRIPTION_MS + 1, 'user');
    expect(transcription.status(long.recordingId)).toEqual({
      phase: 'unsupported',
      reason: 'UNSUPPORTED_DURATION',
    });
    // Exactly 180 s is accepted and sent.
    transcription.request(limit.recordingId, MAX_TRANSCRIPTION_MS);
    expect(engine.calls).toEqual([`transcribe ${limit.recordingId}`]);
    await recordingUnchanged(context, long.entryId);
    expect(await context.transcripts.records(long.recordingId)).toEqual([]);
  });

  it('treats a native UNSUPPORTED_DURATION as unsupported, not as retryable', async () => {
    const engine = new FakeRecordingTranscriber();
    const transcription = new TranscriptionController({
      transcriber: engine,
      transcripts: context.transcripts,
      now: () => 1,
    });
    const a = await readyVoiceEntry(context, 3_000);
    transcription.request(a.recordingId, 3_000);
    engine.complete({ status: 'failed', failure: 'UNSUPPORTED_DURATION' });
    await flush();
    expect(transcription.status(a.recordingId)?.phase).toBe('unsupported');
    transcription.request(a.recordingId, 3_000, 'user');
    expect(engine.waiting).toBe(0);
  });

  it.each([
    ['MODEL_PACK_INVALID'],
    ['DEADLINE_EXCEEDED'],
    ['SOURCE_DAMAGED'],
    ['TRANSCRIPTION_PROTOCOL'],
    ['TRANSCRIPTION_FAILED'],
    ['cancelled'],
  ])(
    'keeps the recording after %s and stores exactly one revision on retry',
    async outcome => {
      const engine = new FakeRecordingTranscriber();
      const transcription = new TranscriptionController({
        transcriber: engine,
        transcripts: context.transcripts,
        now: () => 1,
      });
      const a = await readyVoiceEntry(context, 3_000);
      transcription.request(a.recordingId, 3_000);
      engine.complete(
        outcome === 'cancelled'
          ? { status: 'cancelled' }
          : { status: 'failed', failure: outcome },
      );
      await flush();
      expect(await context.transcripts.records(a.recordingId)).toEqual([]);
      await recordingUnchanged(context, a.entryId);
      // Automatic requests do not loop; the user retries.
      transcription.request(a.recordingId, 3_000, 'automatic');
      expect(engine.waiting).toBe(0);
      transcription.request(a.recordingId, 3_000, 'user');
      engine.complete({
        modelId: MODEL,
        segments: [{ t0Ms: 0, t1Ms: 900, text: 'retried' }],
      });
      await flush();
      await flush();
      const records = await context.transcripts.records(a.recordingId);
      expect(records.map(r => [r.engineRevision, r.text, r.modelId])).toEqual([
        [1, 'retried', MODEL],
      ]);
    },
  );

  it('stores nothing that completes after a lock, and asks the SDK to cancel first', async () => {
    const engine = new ManualTranscriber();
    const transcription = new TranscriptionController({
      transcriber: engine,
      transcripts: context.transcripts,
      now: () => 1,
    });
    const a = await readyVoiceEntry(context, 3_000);
    transcription.request(a.recordingId, 3_000);
    transcription.dispose(); // lock
    expect(engine.calls).toEqual([
      `transcribe ${a.recordingId}`,
      'cancel transcribe-1',
    ]);
    // The request raced to completion anyway: it must not be stored.
    engine.resolve({ segments: [{ t0Ms: 0, t1Ms: 900, text: 'late' }] });
    await flush();
    await flush();
    expect(transcription.status(a.recordingId)).toEqual({ phase: 'cancelled' });
    expect(await context.transcripts.records(a.recordingId)).toEqual([]);
    await recordingUnchanged(context, a.entryId);
  });

  it('recovers after process death: nothing partial is stored and the next open re-queues', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aj-ri2-'));
    const file = path.join(dir, 'journal.db');
    try {
      const before = await openJournal(file);
      const a = await readyVoiceEntry(before, 60_000);
      const dying = new TranscriptionController({
        transcriber: new ManualTranscriber(),
        transcripts: before.transcripts,
        now: () => 1,
      });
      dying.request(a.recordingId, 60_000);
      // The process dies mid-pass: no dispose, no result, the database just closes.
      await before.db.close();

      const after = await openJournal(file, 50);
      expect(await after.transcripts.records(a.recordingId)).toEqual([]);
      expect(await after.transcripts.awaitingFinalPass()).toEqual([
        { recordingId: a.recordingId, durationMs: 60_000 },
      ]);
      const engine = new FakeRecordingTranscriber();
      const restarted = new TranscriptionController({
        transcriber: engine,
        transcripts: after.transcripts,
        now: () => 2,
      });
      for (const waiting of await after.transcripts.awaitingFinalPass()) {
        restarted.request(waiting.recordingId, waiting.durationMs, 'automatic');
      }
      engine.complete({
        modelId: MODEL,
        segments: [{ t0Ms: 0, t1Ms: 59_000, text: 'after restart' }],
      });
      await flush();
      await flush();
      expect(
        (await after.transcripts.records(a.recordingId)).map(r => r.text),
      ).toEqual(['after restart']);
      expect(await after.transcripts.awaitingFinalPass()).toEqual([]);
      await recordingUnchanged(after, a.entryId);
      await after.db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Entry detail for an over-limit recording', () => {
  it('explains the limit and offers no transcribe action', async () => {
    const engine = new FakeRecordingTranscriber();
    const harness = await journalHarness({ transcriber: engine });
    const { entryId } = await readyVoiceEntry(
      harness.context,
      MAX_TRANSCRIPTION_MS + 1_000,
    );
    const view = await harness.render(<EntryDetailScreen entryId={entryId} />);
    await settle();
    expect(view.getByTestId('transcript-unsupported')).toBeTruthy();
    expect(view.queryByTestId('transcript-start')).toBeNull();
    expect(engine.calls).toEqual([]);
    await harness.close();
  });
});
