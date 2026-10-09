// Native playback port (ADR-017). AJR1 chunks are decrypted natively into the
// audio output; no PCM or key reaches JavaScript. A range can be constrained
// so a task source plays exactly its cited excerpt (UX §7, AJ-FR-025).

export type PlaybackEvent =
  | { type: 'position'; positionMs: number }
  | { type: 'ended' }
  | { type: 'failed'; code: 'PLAYBACK_UNAVAILABLE' | 'SOURCE_DAMAGED' };

export interface PlaybackService {
  play(
    recordingId: string,
    range: { startMs: number; endMs?: number },
    onEvent: (event: PlaybackEvent) => void,
  ): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
}
