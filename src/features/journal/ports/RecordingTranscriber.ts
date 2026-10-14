import type { LiveWindow } from '../domain/liveTranscript';
import type { RawEngineSegment } from '../domain/transcript';

// Final transcription of a sealed recording (ADR-017, AJ ADR-022) through the
// packaged Hybrid AI SDK. Native code reads the AJR1 PCM in memory and feeds it
// to the SDK; no audio, key, or file path reaches JavaScript. A failure,
// cancel, lock, or process death never touches the recording.

export interface RecordingTranscription {
  status: 'ok' | 'cancelled' | 'failed';
  /** SDK model identity (`<profileId>_<profileVersion>`), stored with the revision. */
  modelId: string;
  segments: RawEngineSegment[];
  /**
   * Error code only, never a message: `SOURCE_DAMAGED`, `UNSUPPORTED_DURATION`,
   * `MODEL_PACK_INVALID`, `DEADLINE_EXCEEDED`, `TRANSCRIPTION_FAILED`, ...
   */
  failure?: string;
}

export interface RecordingTranscriber {
  transcribe(request: {
    requestId: string;
    recordingId: string;
  }): Promise<RecordingTranscription>;
  /** The pending transcribe then resolves `cancelled` once the request has ended. */
  cancel(requestId: string): void;
}

/**
 * Live provisional text for the capture in progress (ADR-017). Not provided in
 * the AJ-RI-2 build (AJ-RI2-DEC-001): GRI-2L stopped, so there is no accepted
 * live source and capture shows no provisional text.
 */
export interface LiveTranscriber {
  /**
   * Attaches to the open capture of `recordingId`. Resolves to a stop handle,
   * or undefined when live text is unavailable; capture never depends on it.
   */
  start(
    recordingId: string,
    onWindow: (window: LiveWindow) => void,
  ): Promise<{ stop(): void } | undefined>;
}
