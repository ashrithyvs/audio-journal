import {
  initialRecordingSession,
  isTerminal,
  recordingSessionReducer,
  type RecordingSessionAction,
  type RecordingSessionState,
} from '../src/features/journal/domain/recordingSession';
import {
  canStartRecording,
  captureLimitReached,
  pcmBytesFor,
  RECORDING_LIMITS,
} from '../src/features/journal/domain/storagePolicy';

const MIB = 1024 * 1024;
const PLENTY = 10_000 * MIB;
const IDS = { entryId: 'ent_x', recordingId: 'rec_x' };

const run = (
  actions: RecordingSessionAction[],
  from: RecordingSessionState = initialRecordingSession,
) => actions.reduce(recordingSessionReducer, from);

const recording = run([
  { type: 'PREPARE', ...IDS, freeBytes: PLENTY },
  { type: 'STARTED' },
  { type: 'PROGRESS', capturedMs: 5_000, sealedChunks: 5, freeBytes: PLENTY },
]);

describe('storage policy (ADR-017)', () => {
  it('refuses to start below 200 MiB and finishes below 50 MiB', () => {
    expect(canStartRecording(200 * MIB)).toBe(true);
    expect(canStartRecording(200 * MIB - 1)).toBe(false);
    expect(canStartRecording(Number.NaN)).toBe(false);
    expect(captureLimitReached(50 * MIB, 0)).toBeNull();
    expect(captureLimitReached(50 * MIB - 1, 0)).toBe('storage_low');
  });

  it('caps a recording at 60 minutes, with storage taking precedence', () => {
    const max = RECORDING_LIMITS.maxDurationMs;
    expect(captureLimitReached(PLENTY, max - 1)).toBeNull();
    expect(captureLimitReached(PLENTY, max)).toBe('duration_limit');
    expect(captureLimitReached(0, max)).toBe('storage_low');
  });

  it('sizes PCM at 32,000 bytes per second', () => {
    expect(pcmBytesFor(1_000)).toBe(32_000);
    expect(pcmBytesFor(RECORDING_LIMITS.maxDurationMs)).toBe(115_200_000);
  });
});

describe('recording session', () => {
  it('walks the happy path to exactly one ready outcome', () => {
    const paused = recordingSessionReducer(recording, {
      type: 'PAUSE',
      reason: 'user',
    });
    const resumed = recordingSessionReducer(paused, {
      type: 'RESUME',
      freeBytes: PLENTY,
    });
    const finalizing = recordingSessionReducer(resumed, { type: 'FINISH' });
    const ready = recordingSessionReducer(finalizing, {
      type: 'FINALIZED',
      capturedMs: 7_200,
      sealedChunks: 8,
    });
    expect([paused.phase, resumed.phase, finalizing.phase]).toEqual([
      'paused',
      'recording',
      'finalizing',
    ]);
    expect(ready).toEqual({
      phase: 'ready',
      reason: 'user',
      ...IDS,
      capturedMs: 7_200,
      sealedChunks: 8,
    });
    expect(isTerminal(ready)).toBe(true);
  });

  it('refuses to start without space and never enters capture', () => {
    const refused = run([{ type: 'PREPARE', ...IDS, freeBytes: 199 * MIB }]);
    expect(refused).toEqual({ phase: 'idle', refusal: 'STORAGE_EXHAUSTED' });
    expect(run([{ type: 'ACKNOWLEDGE' }], refused)).toEqual({ phase: 'idle' });
  });

  it('returns to idle when the microphone is denied (nothing captured)', () => {
    expect(
      run([
        { type: 'PREPARE', ...IDS, freeBytes: PLENTY },
        { type: 'PREPARE_FAILED', refusal: 'MICROPHONE_DENIED' },
      ]),
    ).toEqual({ phase: 'idle', refusal: 'MICROPHONE_DENIED' });
  });

  it('auto-pauses on audio focus loss and backgrounding, resuming only explicitly', () => {
    const focus = recordingSessionReducer(recording, {
      type: 'PAUSE',
      reason: 'audio_focus_lost',
    });
    const thenBackground = recordingSessionReducer(focus, {
      type: 'PAUSE',
      reason: 'backgrounded',
    });
    expect(thenBackground).toMatchObject({
      phase: 'paused',
      reason: 'audio_focus_lost',
    });
    // Progress while paused (a sealed final chunk) is still recorded.
    expect(
      recordingSessionReducer(thenBackground, {
        type: 'PROGRESS',
        capturedMs: 5_400,
        sealedChunks: 6,
        freeBytes: PLENTY,
      }),
    ).toMatchObject({ phase: 'paused', capturedMs: 5_400, sealedChunks: 6 });
  });

  it('finishes automatically at the duration and storage limits', () => {
    expect(
      recordingSessionReducer(recording, {
        type: 'PROGRESS',
        capturedMs: RECORDING_LIMITS.maxDurationMs,
        sealedChunks: 3_600,
        freeBytes: PLENTY,
      }),
    ).toMatchObject({ phase: 'finalizing', reason: 'duration_limit' });
    expect(
      recordingSessionReducer(recording, {
        type: 'PROGRESS',
        capturedMs: 6_000,
        sealedChunks: 6,
        freeBytes: 10 * MIB,
      }),
    ).toMatchObject({ phase: 'finalizing', reason: 'storage_low' });
  });

  it('finishes instead of resuming when storage ran low while paused', () => {
    const paused = recordingSessionReducer(recording, {
      type: 'PAUSE',
      reason: 'user',
    });
    expect(
      recordingSessionReducer(paused, { type: 'RESUME', freeBytes: MIB }),
    ).toMatchObject({ phase: 'finalizing', reason: 'storage_low' });
  });

  it('never moves progress backwards on out-of-order reports', () => {
    expect(
      recordingSessionReducer(recording, {
        type: 'PROGRESS',
        capturedMs: 1_000,
        sealedChunks: 1,
        freeBytes: PLENTY,
      }),
    ).toMatchObject({ capturedMs: 5_000, sealedChunks: 5 });
  });

  it('keeps sealed audio recoverable after an abnormal end (ADR-008)', () => {
    const interrupted = recordingSessionReducer(recording, {
      type: 'ENDED_ABNORMALLY',
      cause: 'RECORDING_INTERRUPTED',
      capturedMs: 5_300,
      sealedChunks: 5,
    });
    expect(interrupted).toMatchObject({
      phase: 'recoverable',
      cause: 'RECORDING_INTERRUPTED',
      sealedChunks: 5,
    });
  });

  it('fails only when nothing was sealed', () => {
    const started = run([
      { type: 'PREPARE', ...IDS, freeBytes: PLENTY },
      { type: 'STARTED' },
    ]);
    expect(
      recordingSessionReducer(started, {
        type: 'ENDED_ABNORMALLY',
        cause: 'RECORDER_FAILED',
        capturedMs: 0,
        sealedChunks: 0,
      }),
    ).toEqual({ phase: 'failed', ...IDS, cause: 'RECORDER_FAILED' });
    expect(
      run(
        [
          { type: 'FINISH' },
          { type: 'FINALIZED', capturedMs: 0, sealedChunks: 0 },
        ],
        started,
      ),
    ).toEqual({ phase: 'failed', ...IDS, cause: 'EMPTY_RECORDING' });
  });

  it('discards only after explicit confirmation (AJ-FR-003)', () => {
    expect(
      recordingSessionReducer(recording, { type: 'DISCARD', confirmed: false }),
    ).toBe(recording);
    expect(
      recordingSessionReducer(recording, { type: 'DISCARD', confirmed: true }),
    ).toEqual({ phase: 'discarded', ...IDS });
  });

  it('ignores every late native event after a terminal outcome', () => {
    const ready = run(
      [
        { type: 'FINISH' },
        { type: 'FINALIZED', capturedMs: 5_000, sealedChunks: 5 },
      ],
      recording,
    );
    const late: RecordingSessionAction[] = [
      { type: 'PROGRESS', capturedMs: 9_000, sealedChunks: 9, freeBytes: 0 },
      { type: 'PAUSE', reason: 'backgrounded' },
      { type: 'RESUME', freeBytes: PLENTY },
      { type: 'FINISH' },
      { type: 'FINALIZED', capturedMs: 9_000, sealedChunks: 9 },
      {
        type: 'ENDED_ABNORMALLY',
        cause: 'RECORDING_INTERRUPTED',
        capturedMs: 9_000,
        sealedChunks: 9,
      },
      { type: 'DISCARD', confirmed: true },
      { type: 'STARTED' },
      { type: 'PREPARE', ...IDS, freeBytes: PLENTY },
    ];
    expect(run(late, ready)).toBe(ready);
    expect(run([{ type: 'ACKNOWLEDGE' }], ready)).toEqual({ phase: 'idle' });
  });

  it('cannot acknowledge an active capture away', () => {
    expect(recordingSessionReducer(recording, { type: 'ACKNOWLEDGE' })).toBe(
      recording,
    );
  });
});
