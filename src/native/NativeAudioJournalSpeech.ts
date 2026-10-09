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
  readonly models: () => Promise<string>;
  readonly transcribe: (
    requestId: string,
    audioPath: string,
    model: string,
    threads: number,
  ) => Promise<string>;
  readonly cancel: (requestId: string) => void;
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
