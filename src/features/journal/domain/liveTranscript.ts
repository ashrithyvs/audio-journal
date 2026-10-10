import {
  isSpokenText,
  normalizeSegmentText,
  type ProvisionalTranscript,
  type ProvisionalUpdate,
  type RawEngineSegment,
} from './transcript';

// Live windows (LLD §6, ADR-017). Each window re-transcribes the most recent
// audio, so consecutive windows overlap. Where they do, the newer window
// wins: live rows that start inside it are retired, and its segments that
// start before the end of the rows kept are dropped, so text is not repeated.
// The window parameters themselves are still Open (decision 3); this rule
// does not depend on them.

export interface LiveWindow {
  /** Capture time (pauses excluded), like the recording. */
  startMs: number;
  endMs: number;
  /** In capture time, inside the window. */
  segments: RawEngineSegment[];
}

export function planLiveWindow(
  state: ProvisionalTranscript,
  window: LiveWindow,
  capturedMs: number,
  nextId: () => string,
): { retire: string[]; updates: ProvisionalUpdate[] } {
  const live = Object.values(state.segments);
  const retire = live
    .filter(segment => segment.startMs >= window.startMs)
    .map(segment => segment.segmentId);
  const keptEnd = live
    .filter(segment => segment.startMs < window.startMs)
    .reduce((end, segment) => Math.max(end, segment.endMs), 0);
  const updates = window.segments
    .filter(
      segment =>
        Number.isInteger(segment.t0Ms) &&
        Number.isInteger(segment.t1Ms) &&
        segment.t0Ms >= keptEnd &&
        segment.t0Ms <= capturedMs &&
        isSpokenText(normalizeSegmentText(segment.text)),
    )
    .map(segment => ({
      segmentId: nextId(),
      revision: 1,
      startMs: segment.t0Ms,
      endMs: Math.min(Math.max(segment.t1Ms, segment.t0Ms), capturedMs),
      text: segment.text,
    }));
  return { retire, updates };
}
