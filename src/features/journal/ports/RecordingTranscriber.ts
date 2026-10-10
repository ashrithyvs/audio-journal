import type { LiveWindow } from '../domain/liveTranscript';
import type { RawEngineSegment } from '../domain/transcript';

// On-device transcription of a sealed recording (ADR-016, ADR-017). Native
// code decrypts the AJR1 PCM in memory and runs the engine; no audio, key, or
// file path reaches JavaScript. Cancelling never touches the recording.

export interface RecordingTranscription {
  status: 'ok' | 'cancelled' | 'failed';
  /** Engine model ID, stored with the revision. */
  modelId: string;
  segments: RawEngineSegment[];
  /** Error code only, never a message: `SOURCE_DAMAGED`, `TRANSCRIPTION_FAILED`, ... */
  failure?: string;
}

export interface RecordingTranscriber {
  transcribe(
    request: { requestId: string; recordingId: string },
    onSegment?: (segment: RawEngineSegment) => void,
  ): Promise<RecordingTranscription>;
  /** Acknowledged immediately; native compute stops at the next abort point. */
  cancel(requestId: string): void;
}

/** Live provisional text for the capture in progress (ADR-017). */
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
