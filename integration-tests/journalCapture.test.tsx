import { CaptureController } from '../src/features/journal/application/CaptureController';
import { reconcileRecordings } from '../src/features/journal/application/startupReconciliation';
import { FakeRecordingService } from '../test/journal/FakeRecordingService';
import { openJournal } from '../test/sqlite/journalFixtures';

// The capture controller against real SQLite and a scripted native recorder:
// every outcome leaves the database consistent with the sealed file.

const MIB = 1024 * 1024;
type Journal = Awaited<ReturnType<typeof openJournal>>;
let context: Journal;
let recorder: FakeRecordingService;
let clock: number;
let controller: CaptureController;

const flush = () => new Promise(resolve => setImmediate(resolve));

beforeEach(async () => {
  context = await openJournal();
  recorder = new FakeRecordingService();
  clock = 1_700_000_000_000;
  controller = new CaptureController({
    journal: context.journal,
    recorder,
    ids: context.ids,
    now: () => clock,
    progressIntervalMs: 5_000,
  });
});

afterEach(async () => {
  await context.db.close();
});

const session = () => controller.getSnapshot().session;
const entryOf = async () => {
  const current = session();
  return 'entryId' in current
    ? context.journal.getEntry(current.entryId)
    : null;
};

it('records, pauses, resumes, and finishes into a ready voice entry', async () => {
  await controller.start();
  expect(session().phase).toBe('recording');
  recorder.capture(2_500, 0.8);
  expect(controller.getSnapshot().level).toBe(0.8);
  await controller.pause();
  expect(session()).toMatchObject({ phase: 'paused', reason: 'user' });
  await controller.resume();
  recorder.capture(1_200);
  await controller.finish();

  expect(session()).toMatchObject({
    phase: 'ready',
    capturedMs: 3_700,
    sealedChunks: 4,
  });
  expect(await entryOf()).toMatchObject({
    entry: { kind: 'voice', status: 'ready' },
    recording: { state: 'ready', durationMs: 3_700, finishReason: 'user' },
  });
  expect(recorder.calls).toEqual(
    expect.arrayContaining(['pause', 'resume', 'finish']),
  );
});

it('refuses to start without space and creates no entry', async () => {
  recorder.free = 100 * MIB;
  await controller.start();
  expect(session()).toEqual({ phase: 'idle', refusal: 'STORAGE_EXHAUSTED' });
  expect(await context.journal.listTimeline({ limit: 5 })).toEqual([]);
  expect(recorder.calls).toEqual([]);
});

it('marks the draft when the microphone is denied', async () => {
  recorder.refusal = 'MICROPHONE_DENIED';
  await controller.start();
  expect(session()).toEqual({ phase: 'idle', refusal: 'MICROPHONE_DENIED' });
  expect(await context.db.get('SELECT state FROM recordings')).toEqual({
    state: 'failed',
  });
  expect(await context.journal.listTimeline({ limit: 5 })).toEqual([]);
});

it('auto-pauses on audio focus loss and stays paused until the user resumes', async () => {
  await controller.start();
  recorder.capture(1_000);
  recorder.emit({ type: 'paused', reason: 'audio_focus_lost' });
  recorder.emit({ type: 'paused', reason: 'backgrounded' });
  await flush();
  expect(session()).toMatchObject({
    phase: 'paused',
    reason: 'audio_focus_lost',
  });
  expect(await context.db.get('SELECT state FROM recordings')).toEqual({
    state: 'paused',
  });
});

it('finishes automatically when storage runs low', async () => {
  await controller.start();
  recorder.capture(3_000);
  recorder.free = 10 * MIB;
  recorder.capture(500);
  await flush();
  await controller.finish();
  expect(session()).toMatchObject({ phase: 'ready', reason: 'storage_low' });
  expect((await entryOf())?.recording?.finishReason).toBe('storage_low');
});

it('throttles progress writes to bound database work', async () => {
  const writes = jest.spyOn(context.journal, 'updateRecordingProgress');
  await controller.start();
  for (let index = 0; index < 20; index += 1) {
    clock += 500;
    recorder.capture(500);
  }
  await flush();
  // 20 progress events over 10 s at a 5 s interval: start, 5 s, and 10 s.
  expect(writes).toHaveBeenCalledTimes(3);
  expect(await context.db.get('SELECT duration_ms FROM recordings')).toEqual({
    duration_ms: 10_000,
  });
});

it('stores the same recoverable outcome the user sees when native finish fails', async () => {
  await controller.start();
  recorder.capture(2_000);
  recorder.finishFails = true;
  await controller.finish();
  expect(session()).toMatchObject({
    phase: 'recoverable',
    cause: 'RECORDER_FAILED',
  });
  // Even though every chunk authenticates, the row is not promoted.
  expect(await entryOf()).toMatchObject({
    entry: { status: 'recovery_required' },
    recording: { state: 'recoverable', durationMs: 2_000, sealedChunks: 2 },
  });
  // Only this recording's file is rescanned, not the whole archive.
  expect(recorder.calls.filter(call => call.startsWith('scan'))).toEqual([
    expect.stringMatching(/^scan rec_/),
  ]);
});

it('stores a native interruption as recoverable', async () => {
  await controller.start();
  recorder.capture(3_000);
  recorder.emit({
    type: 'ended_abnormally',
    cause: 'RECORDING_INTERRUPTED',
    capturedMs: 3_000,
    sealedChunks: 3,
  });
  await flush();
  await flush();
  expect(session()).toMatchObject({ phase: 'recoverable', sealedChunks: 3 });
  expect((await entryOf())?.recording?.state).toBe('recoverable');
});

it('discards only after confirmation and keeps the rows', async () => {
  await controller.start();
  recorder.capture(1_000);
  await controller.discard(false);
  expect(session().phase).toBe('recording');
  await controller.discard(true);
  expect(session().phase).toBe('discarded');
  expect(await context.db.get('SELECT state FROM recordings')).toEqual({
    state: 'failed',
  });
  expect(recorder.files.size).toBe(0);
});

it('recovers a capture after process death on the next startup', async () => {
  await controller.start();
  recorder.capture(4_000);
  await flush();
  recorder.tearTail();
  // Process dies here: a new controller and a startup reconciliation.
  const summary = await reconcileRecordings(
    context.journal,
    recorder,
    () => clock + 60_000,
  );
  expect(summary).toEqual({
    promoted: 0,
    recoverable: 1,
    failed: 0,
    damaged: 0,
    quarantined: 0,
  });
  expect(recorder.calls.some(call => call.startsWith('dropTornTail'))).toBe(
    true,
  );
  const [entry] = await context.journal.listTimeline({ limit: 5 });
  expect(entry).toMatchObject({
    status: 'recovery_required',
    durationMs: 4_000,
  });
  // Reconciling again is a no-op: the plan is idempotent.
  expect(
    await reconcileRecordings(context.journal, recorder, () => clock + 61_000),
  ).toEqual({
    promoted: 0,
    recoverable: 0,
    failed: 0,
    damaged: 0,
    quarantined: 0,
  });
});

it('quarantines an unknown file without deleting journal rows', async () => {
  recorder.files.set('recordings/stray.ajr', {
    relativePath: 'recordings/stray.ajr',
    headerValid: false,
    authenticatedChunks: 0,
    authenticatedMs: 0,
    trailingBytes: 10,
    byteCount: 0,
  });
  const summary = await reconcileRecordings(
    context.journal,
    recorder,
    () => clock,
  );
  expect(summary.quarantined).toBe(1);
  expect(recorder.calls).toContain('quarantine recordings/stray.ajr');
});
