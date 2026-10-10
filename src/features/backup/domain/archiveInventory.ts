import {
  isLocalId,
  isRecordingRelativePath,
  recordingRelativePath,
} from '../../journal/domain/ids';
import { isSha256Hex } from '../../journal/domain/entry';
import {
  PCM_BYTES_PER_SECOND,
  pcmBytesFor,
  RECORDING_LIMITS,
} from '../../journal/domain/storagePolicy';

// Restore-side validation of an archive's logical inventory (backup-and-
// restore.md §6, LLD §13). It runs after the AJB1 manifest authenticates and
// before anything is staged. It is independent of the AJB1 binary layout,
// which is still being frozen: any layout decodes into this shape first.

export interface InventoryEntry {
  id: string;
  kind: 'voice' | 'written';
  recordingId?: string;
}

export interface InventoryRecording {
  id: string;
  entryId: string;
  path: string;
  durationMs: number;
  /** Plaintext PCM bytes. */
  bytes: number;
  sha256: string;
}

export interface ArchiveInventory {
  formatVersion: number;
  schemaVersion: number;
  entries: readonly InventoryEntry[];
  recordings: readonly InventoryRecording[];
}

// Development ceilings, not product limits. They bound memory and staging work
// for hostile archives; the recording ceiling follows ADR-017's 60 minutes.
export const ARCHIVE_LIMITS = {
  maxEntries: 200_000,
  maxRecordings: 100_000,
  maxRecordingBytes: pcmBytesFor(RECORDING_LIMITS.maxDurationMs),
  maxTotalRecordingBytes: 256 * 1024 ** 3,
} as const;

export type InventoryRejection =
  | 'UNSUPPORTED_VERSION'
  | 'LIMIT_EXCEEDED'
  | 'INVALID_ID'
  | 'DUPLICATE_ID'
  | 'UNSAFE_PATH'
  | 'INVALID_RECORDING'
  | 'DANGLING_REFERENCE'
  | 'INSUFFICIENT_STORAGE';

export interface InventoryContext {
  supportedFormatVersions: readonly number[];
  /** Newest schema this app can migrate from; older archives migrate up. */
  maxSchemaVersion: number;
  availableBytes: number;
  /** Space for the database and staging overhead beyond the recordings. */
  reserveBytes: number;
}

export type InventoryResult =
  | { ok: true; recordingBytes: number }
  | { ok: false; reason: InventoryRejection; index?: number };

const reject = (
  reason: InventoryRejection,
  index?: number,
): InventoryResult => ({ ok: false, reason, index });

const isCount = (value: unknown, max: number): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= max;

export function validateArchiveInventory(
  inventory: ArchiveInventory,
  context: InventoryContext,
): InventoryResult {
  if (
    !context.supportedFormatVersions.includes(inventory.formatVersion) ||
    !Number.isSafeInteger(inventory.schemaVersion) ||
    inventory.schemaVersion < 1 ||
    inventory.schemaVersion > context.maxSchemaVersion
  ) {
    return reject('UNSUPPORTED_VERSION');
  }
  if (
    inventory.entries.length > ARCHIVE_LIMITS.maxEntries ||
    inventory.recordings.length > ARCHIVE_LIMITS.maxRecordings
  ) {
    return reject('LIMIT_EXCEEDED');
  }

  const entries = new Map<string, InventoryEntry>();
  for (const [index, entry] of inventory.entries.entries()) {
    if (!isLocalId(entry.id, 'ent')) {
      return reject('INVALID_ID', index);
    }
    if (entries.has(entry.id)) {
      return reject('DUPLICATE_ID', index);
    }
    if (
      (entry.kind === 'voice') !== isLocalId(entry.recordingId, 'rec') ||
      (entry.kind !== 'voice' && entry.kind !== 'written')
    ) {
      return reject('INVALID_ID', index);
    }
    entries.set(entry.id, entry);
  }

  const recordings = new Set<string>();
  const paths = new Set<string>();
  let total = 0;
  for (const [index, recording] of inventory.recordings.entries()) {
    if (
      !isLocalId(recording.id, 'rec') ||
      !isLocalId(recording.entryId, 'ent')
    ) {
      return reject('INVALID_ID', index);
    }
    if (recordings.has(recording.id)) {
      return reject('DUPLICATE_ID', index);
    }
    // Only the exact path derived from the ID is accepted: no traversal,
    // aliasing, case tricks, or second name for the same recording.
    if (
      !isRecordingRelativePath(recording.path) ||
      recording.path !== recordingRelativePath(recording.id) ||
      paths.has(recording.path)
    ) {
      return reject('UNSAFE_PATH', index);
    }
    if (
      !isCount(recording.durationMs, RECORDING_LIMITS.maxDurationMs) ||
      !isCount(recording.bytes, ARCHIVE_LIMITS.maxRecordingBytes) ||
      // Durations are whole milliseconds; allow one millisecond of PCM.
      Math.abs(recording.bytes - pcmBytesFor(recording.durationMs)) >
        PCM_BYTES_PER_SECOND / 1000 ||
      recording.bytes % 2 !== 0 ||
      !isSha256Hex(recording.sha256)
    ) {
      return reject(
        recording.bytes > ARCHIVE_LIMITS.maxRecordingBytes
          ? 'LIMIT_EXCEEDED'
          : 'INVALID_RECORDING',
        index,
      );
    }
    const owner = entries.get(recording.entryId);
    if (!owner || owner.recordingId !== recording.id) {
      return reject('DANGLING_REFERENCE', index);
    }
    recordings.add(recording.id);
    paths.add(recording.path);
    total += recording.bytes;
    if (total > ARCHIVE_LIMITS.maxTotalRecordingBytes) {
      return reject('LIMIT_EXCEEDED', index);
    }
  }

  // Every voice entry needs its recording: the source must restore whole.
  for (const [index, entry] of inventory.entries.entries()) {
    if (entry.recordingId && !recordings.has(entry.recordingId)) {
      return reject('DANGLING_REFERENCE', index);
    }
  }

  if (total + context.reserveBytes > context.availableBytes) {
    return reject('INSUFFICIENT_STORAGE');
  }
  return { ok: true, recordingBytes: total };
}
