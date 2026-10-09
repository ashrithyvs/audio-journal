// App-owned transcription port (ADR-016, LLD §7). Audio never leaves the
// device through this port; only the resulting text may later be handed to
// Hybrid AI through its generic capability contracts.

export type TranscriptionModelId = 'base.en-q5_1' | 'tiny.en-q5_1';
export const DEFAULT_TRANSCRIPTION_MODEL: TranscriptionModelId = 'base.en-q5_1';

export interface TranscriptSegment {
  t0Ms: number;
  t1Ms: number;
  text: string;
}

export interface TranscriptionTimings {
  readMs: number;
  modelLoadMs: number;
  firstSegmentMs: number;
  inferenceMs: number;
  totalMs: number;
  audioMs: number;
}

export interface TranscriptionResult {
  status: 'ok' | 'cancelled' | 'failed';
  segments: TranscriptSegment[];
  timings?: TranscriptionTimings;
  memory?: { vmRssKb: number; vmHwmKb: number; nativeHeapKb: number };
  /** Error class only, never a message. */
  failure?: string;
}

export interface TranscriptionModelInfo {
  id: TranscriptionModelId;
  sha256: string;
  bundled: boolean;
  isDefault: boolean;
  loaded: boolean;
}

export interface TranscriptionService {
  models(): Promise<TranscriptionModelInfo[]>;
  transcribe(
    request: {
      requestId: string;
      audioPath: string;
      model: TranscriptionModelId;
      threads?: number;
    },
    onSegment?: (segment: TranscriptSegment) => void,
  ): Promise<TranscriptionResult>;
  cancel(requestId: string): void;
}

export const transcriptText = (result: TranscriptionResult) =>
  result.segments
    .map(segment => segment.text.trim())
    .filter(Boolean)
    .join(' ');
