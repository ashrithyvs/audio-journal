import React from 'react';
import { act, fireEvent } from '@testing-library/react-native';

import { CaptureController } from '../src/features/journal/application/CaptureController';
import { TranscriptionController } from '../src/features/journal/application/TranscriptionController';
import { EntryDetailScreen } from '../src/features/journal/ui/EntryDetailScreen';
import { FakeRecordingService } from '../test/journal/FakeRecordingService';
import { FakeRecordingTranscriber } from '../test/journal/FakeRecordingTranscriber';
import { journalHarness, settle } from '../test/journal/renderJournal';
import { openJournal, readyVoiceEntry } from '../test/sqlite/journalFixtures';

// Final on-device passes (ADR-017) against real SQLite: one at a time,
// validated before storage, and never able to change the recording.

const flush = () => new Promise(resolve => setImmediate(resolve));
type Journal = Awaited<ReturnType<typeof openJournal>>;

describe('TranscriptionController', () => {
  let context: Journal;
  let engine: FakeRecordingTranscriber;
  let saved: string[];
  let transcription: TranscriptionController;

  beforeEach(async () => {
    context = await openJournal();
    engine = new FakeRecordingTranscriber();
    saved = [];
    transcription = new TranscriptionController({
      transcriber: engine,
      transcripts: context.transcripts,
      now: () => 1_800_000_000_000,
      onSaved: recordingId => saved.push(recordingId),
    });
  });

  afterEach(async () => {
    await context.db.close();
  });

  it('runs the final pass once a capture is saved and stores revision 1', async () => {
    const recorder = new FakeRecordingService();
    const capture = new CaptureController({
      journal: context.journal,
      recorder,
      ids: context.ids,
      now: () => 1_800_000_000_000,
      onSaved: (recordingId, durationMs) =>
        transcription.request(recordingId, durationMs),
    });
    await capture.start();
    recorder.capture(2_400);
    await capture.finish();
    await flush();
    const session = capture.getSnapshot().session;
    if (session.phase !== 'ready') {
      throw new Error(`expected ready, got ${session.phase}`);
    }
    expect(transcription.status(session.recordingId)).toEqual({
      phase: 'running',
    });

    engine.complete({
      segments: [
        { t0Ms: 0, t1Ms: 1_200, text: ' Hello  there ' },
        { t0Ms: 1_200, t1Ms: 2_900, text: 'again' }, // overshoot is clamped
      ],
    });
    await flush();
    await flush();
    expect(saved).toEqual([session.recordingId]);
    expect(transcription.status(session.recordingId)).toBeUndefined();
    const view = await context.transcripts.current(session.recordingId);
    expect(view).toMatchObject({ kind: 'final' });
    expect(view.kind === 'final' && view.lines.map(line => line.text)).toEqual([
      'Hello there',
      'again',
    ]);
  });

  it('runs one pass at a time, in order, and cancels a queued one', async () => {
    const a = await readyVoiceEntry(context, 3_000);
    const b = await readyVoiceEntry(context, 3_000);
    const c = await readyVoiceEntry(context, 3_000);
    transcription.request(a.recordingId, 3_000);
    transcription.request(b.recordingId, 3_000);
    transcription.request(c.recordingId, 3_000);
    transcription.request(a.recordingId, 3_000); // already running: ignored
    expect(engine.calls).toEqual([`transcribe ${a.recordingId}`]);
    transcription.cancel(b.recordingId);
    expect(transcription.status(b.recordingId)).toEqual({ phase: 'cancelled' });

    engine.complete({ segments: [{ t0Ms: 0, t1Ms: 900, text: 'one' }] });
    await flush();
    await flush();
    expect(engine.calls).toEqual([
      `transcribe ${a.recordingId}`,
      `transcribe ${c.recordingId}`,
    ]);
    // Cancelling the running pass leaves no revision and the recording as it was.
    transcription.cancel(c.recordingId);
    await flush();
    expect(transcription.status(c.recordingId)).toEqual({ phase: 'cancelled' });
    expect((await context.transcripts.current(c.recordingId)).kind).toBe(
      'none',
    );
  });

  it('stores nothing from a failed or malformed pass', async () => {
    const a = await readyVoiceEntry(context, 3_000);
    transcription.request(a.recordingId, 3_000);
    engine.complete({ status: 'failed', failure: 'SOURCE_DAMAGED' });
    await flush();
    expect(transcription.status(a.recordingId)).toEqual({
      phase: 'failed',
      reason: 'SOURCE_DAMAGED',
    });

    transcription.request(a.recordingId, 3_000); // the user retries
    engine.complete({
      segments: [
        { t0Ms: 1_000, t1Ms: 1_500, text: 'later' },
        { t0Ms: 0, t1Ms: 500, text: 'earlier' }, // out of order
      ],
    });
    await flush();
    expect(transcription.status(a.recordingId)).toEqual({
      phase: 'failed',
      reason: 'INVALID_RESULT',
    });
    expect(await context.transcripts.records(a.recordingId)).toEqual([]);
    expect(
      (await context.journal.getEntry(a.entryId))?.recording,
    ).toMatchObject({ state: 'ready', durationMs: 3_000 });
  });

  it('never retries automatically what failed or was cancelled in this session', async () => {
    const a = await readyVoiceEntry(context, 3_000);
    transcription.request(a.recordingId, 3_000);
    engine.complete({ status: 'failed', failure: 'TRANSCRIPTION_FAILED' });
    await flush();
    transcription.request(a.recordingId, 3_000, 'automatic');
    expect(engine.waiting).toBe(0);
    transcription.request(a.recordingId, 3_000); // the user asks again
    expect(engine.waiting).toBe(1);
    transcription.cancel(a.recordingId);
    await flush();
    transcription.request(a.recordingId, 3_000, 'automatic');
    expect(engine.waiting).toBe(0);
  });

  it('counts an empty pass as done, so silence is not transcribed again', async () => {
    const silent = await readyVoiceEntry(context, 3_000);
    const spoken = await readyVoiceEntry(context, 3_000);
    expect(await context.transcripts.awaitingFinalPass()).toEqual([
      { recordingId: silent.recordingId, durationMs: 3_000 },
      { recordingId: spoken.recordingId, durationMs: 3_000 },
    ]);
    transcription.request(silent.recordingId, 3_000);
    engine.complete({ segments: [] });
    await flush();
    await flush();
    expect(await context.transcripts.awaitingFinalPass()).toEqual([
      { recordingId: spoken.recordingId, durationMs: 3_000 },
    ]);
    // A later pass still gets the next revision number.
    expect(
      await context.transcripts.saveEngineRevision({
        recordingId: silent.recordingId,
        modelId: 'base.en-q5_1',
        segments: [{ startMs: 0, endMs: 900, text: 'late' }],
        createdAt: 9,
      }),
    ).toEqual({ engineRevision: 2, segmentCount: 1 });
  });

  it('starts nothing after dispose and cancels the running pass', async () => {
    const a = await readyVoiceEntry(context, 3_000);
    const b = await readyVoiceEntry(context, 3_000);
    transcription.request(a.recordingId, 3_000);
    transcription.request(b.recordingId, 3_000);
    transcription.dispose();
    await flush();
    expect(engine.calls).toEqual([
      `transcribe ${a.recordingId}`,
      expect.stringMatching(/^cancel /),
    ]);
    transcription.request(b.recordingId, 3_000);
    expect(engine.waiting).toBe(0);
  });
});

describe('Entry detail transcript action', () => {
  it('makes the transcript by itself, shows progress, then the final lines', async () => {
    const engine = new FakeRecordingTranscriber();
    const harness = await journalHarness({ transcriber: engine });
    const { entryId } = await readyVoiceEntry(harness.context, 4_000);
    const view = await harness.render(<EntryDetailScreen entryId={entryId} />);
    await settle();
    // Queued when the journal opened (after unlock): no button press needed.
    expect(view.getByTestId('transcript-none')).toBeTruthy();
    expect(view.getByTestId('transcript-running')).toBeTruthy();
    await act(async () => {
      engine.complete({
        segments: [{ t0Ms: 0, t1Ms: 3_000, text: 'Dear diary' }],
      });
    });
    await settle();
    expect(view.getByTestId('transcript-text-0')).toHaveTextContent(
      'Dear diary',
    );
    expect(view.queryByTestId('transcript-start')).toBeNull();
    await harness.close();
  });

  it('lets the user cancel, then transcribe on request', async () => {
    const engine = new FakeRecordingTranscriber();
    const harness = await journalHarness({ transcriber: engine });
    const { entryId } = await readyVoiceEntry(harness.context, 4_000);
    const view = await harness.render(<EntryDetailScreen entryId={entryId} />);
    await settle();
    await fireEvent.press(view.getByTestId('transcript-cancel'));
    await settle();
    expect(view.getByTestId('transcript-start')).toHaveTextContent(
      'Transcribe',
    );
    await fireEvent.press(view.getByTestId('transcript-start'));
    expect(view.getByTestId('transcript-running')).toBeTruthy();
    expect(
      engine.calls.filter(call => call.startsWith('transcribe')),
    ).toHaveLength(2);
    await harness.close();
  });

  it('offers a retry after a failure and keeps the recording', async () => {
    const engine = new FakeRecordingTranscriber();
    const harness = await journalHarness({ transcriber: engine });
    const { entryId } = await readyVoiceEntry(harness.context, 4_000);
    const view = await harness.render(<EntryDetailScreen entryId={entryId} />);
    await settle();
    await act(async () => {
      engine.complete({ status: 'failed', failure: 'TRANSCRIPTION_FAILED' });
    });
    await settle();
    expect(view.getByTestId('transcript-failed')).toHaveTextContent(
      /recording is safe/,
    );
    expect(view.getByTestId('transcript-start')).toHaveTextContent('Try again');
    await fireEvent.press(view.getByTestId('transcript-start'));
    expect(view.getByTestId('transcript-running')).toBeTruthy();
    await harness.close();
  });

  it('queues recordings without a full pass when the journal opens', async () => {
    const engine = new FakeRecordingTranscriber();
    const harness = await journalHarness({ transcriber: engine });
    const first = await readyVoiceEntry(harness.context, 2_000, 1_000);
    const second = await readyVoiceEntry(harness.context, 2_000, 2_000);
    await harness.render(<EntryDetailScreen entryId={first.entryId} />);
    await settle();
    // One at a time, oldest first.
    expect(engine.calls).toEqual([`transcribe ${first.recordingId}`]);
    await act(async () => engine.complete({ segments: [] }));
    await settle();
    expect(engine.calls).toEqual([
      `transcribe ${first.recordingId}`,
      `transcribe ${second.recordingId}`,
    ]);
    await harness.close();
  });

  it('says no speech was found after an empty pass, and offers no new one', async () => {
    const engine = new FakeRecordingTranscriber();
    const harness = await journalHarness({ transcriber: engine });
    const { entryId } = await readyVoiceEntry(harness.context, 4_000);
    const view = await harness.render(<EntryDetailScreen entryId={entryId} />);
    await settle();
    await act(async () => engine.complete({ segments: [] }));
    await settle();
    expect(view.getByTestId('transcript-empty')).toHaveTextContent(
      'No speech was found in this recording.',
    );
    expect(view.queryByTestId('transcript-start')).toBeNull();
    await harness.close();
  });

  it('offers no transcript action without an on-device engine', async () => {
    const harness = await journalHarness();
    const { entryId } = await readyVoiceEntry(harness.context, 4_000);
    const view = await harness.render(<EntryDetailScreen entryId={entryId} />);
    await settle();
    expect(view.queryByTestId('transcript-start')).toBeNull();
    await harness.close();
  });
});
