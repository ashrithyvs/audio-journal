import { isSha256Hex } from '../../features/journal/domain/entry';
import type {
  AbnormalEnd,
  PauseReason,
  StartRefusal,
} from '../../features/journal/domain/recordingSession';
import type { RecordingFileScan } from '../../features/journal/domain/reconciliation';
import type { PlaybackEvent } from '../../features/journal/ports/PlaybackService';
import type {
  FinalizedRecording,
  RecordingEvent,
} from '../../features/journal/ports/RecordingService';

// Strict parsing of the AudioJournalRecordings module's results and events.
// Native code is trusted, but nothing malformed reaches the domain: a bad
// result throws RECORDER_PROTOCOL, and a bad event is dropped.

const REFUSALS: readonly StartRefusal[] = [
  'STORAGE_EXHAUSTED',
  'MICROPHONE_DENIED',
  'RECORDER_UNAVAILABLE',
];
const PAUSE_REASONS: readonly PauseReason[] = [
  'user',
  'audio_focus_lost',
  'backgrounded',
];
const ABNORMAL_ENDS: readonly AbnormalEnd[] = [
  'RECORDING_INTERRUPTED',
  'STORAGE_EXHAUSTED',
  'RECORDER_FAILED',
];

function protocolError(): Error {
  return Object.assign(new Error('RECORDER_PROTOCOL'), {
    code: 'RECORDER_PROTOCOL',
  });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw protocolError();
  }
  return value as Record<string, unknown>;
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw protocolError();
  }
  return value as number;
}

function includes<T extends string>(list: readonly T[], value: unknown) {
  return (
    typeof value === 'string' && (list as readonly string[]).includes(value)
  );
}

export function parsePrepareResult(
  json: string,
): { ok: true } | { ok: false; refusal: StartRefusal } {
  const value = record(JSON.parse(json));
  if (value.ok === true) {
    return { ok: true };
  }
  if (value.ok === false && includes(REFUSALS, value.refusal)) {
    return { ok: false, refusal: value.refusal as StartRefusal };
  }
  throw protocolError();
}

export function parseFinalized(json: string): FinalizedRecording {
  const value = record(JSON.parse(json));
  if (!isSha256Hex(value.contentSha256)) {
    throw protocolError();
  }
  return {
    durationMs: count(value.durationMs),
    sealedChunks: count(value.sealedChunks),
    byteCount: count(value.byteCount),
    contentSha256: value.contentSha256,
  };
}

function parseFileScan(raw: unknown): RecordingFileScan {
  const value = record(raw);
  if (
    typeof value.relativePath !== 'string' ||
    typeof value.headerValid !== 'boolean'
  ) {
    throw protocolError();
  }
  const base = {
    relativePath: value.relativePath,
    headerValid: value.headerValid,
    fileBytes: count(value.fileBytes),
  };
  if (value.check === 'header') {
    return { ...base, check: 'header' };
  }
  if (value.check !== 'authenticated') {
    throw protocolError();
  }
  if (value.contentSha256 !== undefined && !isSha256Hex(value.contentSha256)) {
    throw protocolError();
  }
  if (
    value.tail !== 'none' &&
    value.tail !== 'torn' &&
    value.tail !== 'damaged'
  ) {
    throw protocolError();
  }
  return {
    ...base,
    check: 'authenticated',
    authenticatedChunks: count(value.authenticatedChunks),
    authenticatedMs: count(value.authenticatedMs),
    trailingBytes: count(value.trailingBytes),
    tail: value.tail,
    byteCount: count(value.byteCount),
    ...(value.contentSha256 === undefined
      ? {}
      : { contentSha256: value.contentSha256 }),
  };
}

export function parseScan(json: string): RecordingFileScan[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value)) {
    throw protocolError();
  }
  return value.map(parseFileScan);
}

export interface NativeRecordingEvent {
  recordingId: string;
  type: string;
  reason: string;
  capturedMs: number;
  sealedChunks: number;
  byteCount: number;
  freeBytes: number;
  level: number;
}

const finite = (value: number) => (Number.isFinite(value) ? value : 0);

export function toRecordingEvent(
  event: NativeRecordingEvent,
): RecordingEvent | undefined {
  const progress = {
    capturedMs: finite(event.capturedMs),
    sealedChunks: finite(event.sealedChunks),
  };
  switch (event.type) {
    case 'started':
      return { type: 'started' };
    case 'progress':
      return {
        type: 'progress',
        ...progress,
        byteCount: finite(event.byteCount),
        freeBytes: finite(event.freeBytes),
        level: Math.min(1, Math.max(0, finite(event.level))),
      };
    case 'paused':
      return includes(PAUSE_REASONS, event.reason)
        ? { type: 'paused', reason: event.reason as PauseReason }
        : undefined;
    case 'ended_abnormally':
      return {
        type: 'ended_abnormally',
        cause: includes(ABNORMAL_ENDS, event.reason)
          ? (event.reason as AbnormalEnd)
          : 'RECORDER_FAILED',
        ...progress,
      };
    default:
      return undefined;
  }
}

export interface NativePlaybackEvent {
  playbackId: string;
  type: string;
  positionMs: number;
  code: string;
}

export function toPlaybackEvent(
  event: NativePlaybackEvent,
): PlaybackEvent | undefined {
  switch (event.type) {
    case 'position':
    case 'paused':
      return { type: event.type, positionMs: finite(event.positionMs) };
    case 'ended':
      return { type: 'ended' };
    case 'failed':
      return {
        type: 'failed',
        code:
          event.code === 'SOURCE_DAMAGED'
            ? 'SOURCE_DAMAGED'
            : 'PLAYBACK_UNAVAILABLE',
      };
    default:
      return undefined;
  }
}
