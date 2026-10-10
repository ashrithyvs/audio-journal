import type { CodegenTypes, TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

// Native AJR1 capture and playback (ADR-017, LLD §5). PCM and keys stay
// native; events carry progress, levels, and positions only. Results are
// JSON strings so each adapter validates one shape.
export interface Spec extends TurboModule {
  /** `type`: started | progress | paused | ended_abnormally. */
  readonly onRecordingEvent: CodegenTypes.EventEmitter<{
    recordingId: string;
    type: string;
    /** Pause reason or abnormal-end cause; '' otherwise. */
    reason: string;
    capturedMs: number;
    sealedChunks: number;
    byteCount: number;
    freeBytes: number;
    level: number;
  }>;
  /** `type`: position | paused | ended | failed. */
  readonly onPlaybackEvent: CodegenTypes.EventEmitter<{
    playbackId: string;
    type: string;
    positionMs: number;
    /** Failure code; '' otherwise. */
    code: string;
  }>;
  readonly freeBytes: () => Promise<number>;
  /** `{"ok":true}` or `{"ok":false,"refusal":...}`. */
  readonly prepare: (recordingId: string) => Promise<string>;
  readonly start: (recordingId: string) => Promise<void>;
  readonly pause: () => Promise<void>;
  readonly resume: () => Promise<void>;
  /** `{durationMs, sealedChunks, byteCount, contentSha256}`. */
  readonly finish: () => Promise<string>;
  readonly discard: (recordingId: string) => Promise<void>;
  /** `authenticateJson`: recording IDs to authenticate frame by frame. */
  readonly scan: (authenticateJson: string) => Promise<string>;
  readonly dropTornTail: (
    recordingId: string,
    sealedChunks: number,
  ) => Promise<void>;
  readonly quarantine: (relativePath: string) => Promise<void>;
  /** `endMs` < 0 plays to the end. */
  readonly play: (
    playbackId: string,
    recordingId: string,
    startMs: number,
    endMs: number,
  ) => Promise<void>;
  readonly pausePlayback: () => Promise<void>;
  readonly stopPlayback: () => Promise<void>;
}

export default TurboModuleRegistry.get<Spec>('AudioJournalRecordings');
