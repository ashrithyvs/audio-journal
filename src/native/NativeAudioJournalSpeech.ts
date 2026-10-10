import type { CodegenTypes, TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

// App-owned on-device transcription (ADR-016). Result payloads are JSON;
// segment text is delivered only through `onSegment` and is never logged.
export interface Spec extends TurboModule {
  readonly onSegment: CodegenTypes.EventEmitter<{
    requestId: string;
    t0Ms: number;
    t1Ms: number;
    text: string;
  }>;
  /** One live window over the capture in progress; text is never logged. */
  readonly onLiveWindow: CodegenTypes.EventEmitter<{
    requestId: string;
    startMs: number;
    endMs: number;
    /** `[{t0Ms, t1Ms, text}]` in capture time. */
    segmentsJson: string;
  }>;
  readonly models: () => Promise<string>;
  readonly transcribe: (
    requestId: string,
    audioPath: string,
    model: string,
    threads: number,
  ) => Promise<string>;
  /**
   * Final pass over a sealed AJR1 recording, decrypted natively; no audio or
   * path crosses the bridge. Segments arrive through `onSegment` in
   * absolute time.
   */
  readonly transcribeRecording: (
    requestId: string,
    recordingId: string,
    model: string,
    threads: number,
  ) => Promise<string>;
  readonly cancel: (requestId: string) => void;
  /** Attaches live transcription to the open capture; false if it is not open. */
  readonly startLive: (
    requestId: string,
    recordingId: string,
    model: string,
    threads: number,
  ) => Promise<boolean>;
  readonly stopLive: (requestId: string) => void;
  /** Native transcriptions still computing, including early-cancelled ones. */
  readonly activeTranscriptions: () => number;
  /** Development fixtures directory (app-scoped external files), or ''. */
  readonly evalDirectory: () => string;
  readonly readEvalFile: (relativePath: string) => Promise<string>;
  readonly appendEvalFile: (
    relativePath: string,
    line: string,
  ) => Promise<void>;
  readonly memorySnapshot: () => string;
}

export default TurboModuleRegistry.get<Spec>('AudioJournalSpeech');
