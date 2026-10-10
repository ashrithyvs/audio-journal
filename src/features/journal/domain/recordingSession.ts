import {
  canStartRecording,
  captureLimitReached,
  type CaptureLimit,
} from './storagePolicy';

// One capture session (LLD §5, ADR-017). Native code owns the audio and the
// sealed AJR1 chunks; this reducer owns which outcome the user sees. It exposes
// exactly one terminal outcome per session and ignores late native events.

export type PauseReason = 'user' | 'audio_focus_lost' | 'backgrounded';
export type FinishReason = 'user' | CaptureLimit;
export type StartRefusal =
  | 'STORAGE_EXHAUSTED'
  | 'MICROPHONE_DENIED'
  | 'RECORDER_UNAVAILABLE';
export type AbnormalEnd =
  | 'RECORDING_INTERRUPTED'
  | 'STORAGE_EXHAUSTED'
  | 'RECORDER_FAILED';

interface Capture {
  entryId: string;
  recordingId: string;
  /** Captured audio, excluding pauses, as reported by native code. */
  capturedMs: number;
  /** AJR1 chunks already sealed and authenticated on disk. */
  sealedChunks: number;
}

export type RecordingSessionState =
  | { phase: 'idle'; refusal?: StartRefusal }
  | { phase: 'preparing'; entryId: string; recordingId: string }
  | ({ phase: 'recording' } & Capture)
  | ({ phase: 'paused'; reason: PauseReason } & Capture)
  | ({ phase: 'finalizing'; reason: FinishReason } & Capture)
  | ({ phase: 'ready'; reason: FinishReason } & Capture)
  | ({ phase: 'recoverable'; cause: AbnormalEnd } & Capture)
  | {
      phase: 'failed';
      entryId: string;
      recordingId: string;
      cause: AbnormalEnd | 'EMPTY_RECORDING';
    }
  | { phase: 'discarded'; entryId: string; recordingId: string };

export type RecordingSessionAction =
  | { type: 'PREPARE'; entryId: string; recordingId: string; freeBytes: number }
  | { type: 'PREPARE_FAILED'; refusal: StartRefusal }
  | { type: 'STARTED' }
  | {
      type: 'PROGRESS';
      capturedMs: number;
      sealedChunks: number;
      freeBytes: number;
    }
  | { type: 'PAUSE'; reason: PauseReason }
  | { type: 'RESUME'; freeBytes: number }
  | { type: 'FINISH' }
  | { type: 'FINALIZED'; capturedMs: number; sealedChunks: number }
  | {
      type: 'ENDED_ABNORMALLY';
      cause: AbnormalEnd;
      capturedMs: number;
      sealedChunks: number;
    }
  | { type: 'DISCARD'; confirmed: boolean }
  | { type: 'ACKNOWLEDGE' };

export const initialRecordingSession: RecordingSessionState = { phase: 'idle' };

const TERMINAL = new Set(['ready', 'recoverable', 'failed', 'discarded']);

export function isTerminal(state: RecordingSessionState): boolean {
  return TERMINAL.has(state.phase);
}

function capture(state: Capture): Capture {
  return {
    entryId: state.entryId,
    recordingId: state.recordingId,
    capturedMs: state.capturedMs,
    sealedChunks: state.sealedChunks,
  };
}

/** Native progress never moves backwards; a stale report keeps the newer one. */
function advance(
  state: Capture,
  capturedMs: number,
  sealedChunks: number,
): Capture {
  return {
    ...capture(state),
    capturedMs: Math.max(state.capturedMs, capturedMs),
    sealedChunks: Math.max(state.sealedChunks, sealedChunks),
  };
}

export function recordingSessionReducer(
  state: RecordingSessionState,
  action: RecordingSessionAction,
): RecordingSessionState {
  switch (action.type) {
    case 'PREPARE':
      if (state.phase !== 'idle') {
        return state;
      }
      if (!canStartRecording(action.freeBytes)) {
        return { phase: 'idle', refusal: 'STORAGE_EXHAUSTED' };
      }
      return {
        phase: 'preparing',
        entryId: action.entryId,
        recordingId: action.recordingId,
      };
    case 'PREPARE_FAILED':
      // Nothing was captured, so nothing needs preserving.
      return state.phase === 'preparing'
        ? { phase: 'idle', refusal: action.refusal }
        : state;
    case 'STARTED':
      return state.phase === 'preparing'
        ? {
            phase: 'recording',
            entryId: state.entryId,
            recordingId: state.recordingId,
            capturedMs: 0,
            sealedChunks: 0,
          }
        : state;
    case 'PROGRESS': {
      if (state.phase !== 'recording' && state.phase !== 'paused') {
        return state;
      }
      const next = advance(state, action.capturedMs, action.sealedChunks);
      const limit = captureLimitReached(action.freeBytes, next.capturedMs);
      if (limit) {
        return { phase: 'finalizing', reason: limit, ...next };
      }
      return { ...state, ...next };
    }
    case 'PAUSE':
      // A second cause while paused keeps the first: resuming stays explicit.
      return state.phase === 'recording'
        ? { phase: 'paused', reason: action.reason, ...capture(state) }
        : state;
    case 'RESUME': {
      if (state.phase !== 'paused') {
        return state;
      }
      const limit = captureLimitReached(action.freeBytes, state.capturedMs);
      return limit
        ? { phase: 'finalizing', reason: limit, ...capture(state) }
        : { phase: 'recording', ...capture(state) };
    }
    case 'FINISH':
      return state.phase === 'recording' || state.phase === 'paused'
        ? { phase: 'finalizing', reason: 'user', ...capture(state) }
        : state;
    case 'FINALIZED': {
      if (state.phase !== 'finalizing') {
        return state;
      }
      const next = advance(state, action.capturedMs, action.sealedChunks);
      return next.sealedChunks > 0
        ? { phase: 'ready', reason: state.reason, ...next }
        : {
            phase: 'failed',
            entryId: state.entryId,
            recordingId: state.recordingId,
            cause: 'EMPTY_RECORDING',
          };
    }
    case 'ENDED_ABNORMALLY': {
      if (
        state.phase !== 'recording' &&
        state.phase !== 'paused' &&
        state.phase !== 'finalizing'
      ) {
        return state;
      }
      // Any sealed chunk is source material: keep it recoverable (ADR-008).
      const next = advance(state, action.capturedMs, action.sealedChunks);
      return next.sealedChunks > 0
        ? { phase: 'recoverable', cause: action.cause, ...next }
        : {
            phase: 'failed',
            entryId: state.entryId,
            recordingId: state.recordingId,
            cause: action.cause,
          };
    }
    case 'DISCARD':
      // AJ-FR-003: cancelling a capture needs explicit confirmation.
      return action.confirmed &&
        (state.phase === 'recording' || state.phase === 'paused')
        ? {
            phase: 'discarded',
            entryId: state.entryId,
            recordingId: state.recordingId,
          }
        : state;
    case 'ACKNOWLEDGE':
      return isTerminal(state) ||
        (state.phase === 'idle' && state.refusal !== undefined)
        ? initialRecordingSession
        : state;
  }
}
