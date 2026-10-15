import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

// Final transcription of sealed recordings through the packaged Hybrid AI SDK
// (AJ ADR-021/022). Native code feeds the AJR1 PCM to the SDK; no audio, key,
// or file path crosses the bridge. Results are JSON with codes, times, and the
// validated segments; their text is never logged.
export interface Spec extends TurboModule {
  /**
   * One explicit-local `audio.transcribe@1` request over a sealed recording of
   * at most 180 seconds. Resolves
   * `{status, modelId, segments: [{t0Ms, t1Ms, text}], failure?, timings}`.
   */
  readonly transcribeRecording: (
    requestId: string,
    recordingId: string,
  ) => Promise<string>;
  /** The request then resolves `cancelled` once the SDK operation has ended. */
  readonly cancel: (requestId: string) => void;
  /** Requests still running natively. */
  readonly activeTranscriptions: () => number;
  /** Content-free counts, model leases, step traces, and process memory. */
  readonly diagnostics: () => Promise<string>;
}

export default TurboModuleRegistry.get<Spec>('AudioJournalSpeech');
