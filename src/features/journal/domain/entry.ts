// Journal entries (LLD §2). A written entry's text and a voice entry's
// recording are the source of truth (ADR-002); everything else derives from
// them. Entries have no category, mood, or AI field (ADR-003).

export type EntryKind = 'voice' | 'written';
export type EntryStatus = 'draft' | 'ready' | 'recovery_required' | 'deleted';
export type RecordingState =
  | 'preparing'
  | 'recording'
  | 'paused'
  | 'finalizing'
  | 'ready'
  | 'recoverable'
  | 'failed';
export type RecordingFinishReason =
  | 'user'
  | 'duration_limit'
  | 'storage_low'
  | 'recovered';

export const AJR1_FORMAT = 'AJR1/pcm_s16le/16000/1';

export interface JournalEntry {
  id: string;
  kind: EntryKind;
  status: EntryStatus;
  createdAt: number;
  updatedAt: number;
  title?: string;
  /** Written entries only. */
  sourceText?: string;
}

export interface RecordingRecord {
  id: string;
  entryId: string;
  relativePath: string;
  state: RecordingState;
  format: typeof AJR1_FORMAT;
  startedAt: number;
  endedAt?: number;
  durationMs: number;
  sealedChunks: number;
  byteCount: number;
  /** SHA-256 of the plaintext PCM, recorded at finalization. */
  contentSha256?: string;
  finishReason?: RecordingFinishReason;
}

export const NONTERMINAL_RECORDING_STATES: readonly RecordingState[] = [
  'preparing',
  'recording',
  'paused',
  'finalizing',
];

// Development bounds, not product limits: large enough for any diary entry,
// small enough that a hostile restore cannot exhaust memory with one row.
export const ENTRY_LIMITS = {
  maxWrittenChars: 200_000,
  maxTitleChars: 200,
} as const;

export type TextRejection = 'EMPTY' | 'TOO_LONG';

export function validateWrittenText(
  text: string,
): { ok: true; text: string } | { ok: false; reason: TextRejection } {
  // Keep the author's whitespace; only reject text with no content.
  if (text.trim().length === 0) {
    return { ok: false, reason: 'EMPTY' };
  }
  if (text.length > ENTRY_LIMITS.maxWrittenChars) {
    return { ok: false, reason: 'TOO_LONG' };
  }
  return { ok: true, text };
}

export function validateTitle(
  title: string | undefined,
): { ok: true; title?: string } | { ok: false; reason: TextRejection } {
  const trimmed = title?.replace(/\s+/g, ' ').trim();
  if (!trimmed) {
    return { ok: true };
  }
  return trimmed.length > ENTRY_LIMITS.maxTitleChars
    ? { ok: false, reason: 'TOO_LONG' }
    : { ok: true, title: trimmed };
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}
