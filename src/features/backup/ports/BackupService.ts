import type { RestoreTargetCounts } from '../domain/restoreTarget';

// Encrypted backup and restore (ADR-017, backup-and-restore.md §2 and §9).
// The codec is native: JavaScript sees counts, sizes, typed codes, and, for
// damaged entries, their local labels. Never journal content or keys.

export type SecretKind = 'password' | 'recoveryKey';

export type OperationFailure =
  | { status: 'cancelled' }
  | { status: 'failed'; code: string; stage?: string };

/** An entry whose recording can no longer be read in full. */
export interface DamagedEntry {
  entryId: string;
  recordingId: string;
  createdAtMs: number;
  title?: string;
  component: 'recording';
}

export type BackupEstimate =
  | {
      status: 'ready';
      entries: number;
      recordings: number;
      segments: number;
      pcmBytes: number;
      archiveBytes: number;
      freeBytes: number;
    }
  | { status: 'damaged'; entries: DamagedEntry[] }
  | OperationFailure;

export type PreparedBackup =
  | {
      status: 'ready';
      bytes: number;
      excluded: number;
      entries: number;
      recordings: number;
    }
  | { status: 'damaged'; entries: DamagedEntry[] }
  | OperationFailure;

export type SavedBackup =
  | { status: 'complete'; bytes: number; name?: string }
  | { status: 'cancelled' }
  | { status: 'failed'; code: string; destinationRemoved?: boolean };

export type PickedArchive =
  | { status: 'picked'; bytes: number; secretKind: SecretKind; name?: string }
  | OperationFailure;

export type OpenedArchive =
  | {
      status: 'opened';
      createdAtMs: number;
      entries: number;
      recordings: number;
      segments: number;
      pcmBytes: number;
      requiredBytes: number;
    }
  | OperationFailure;

export type Activation =
  | { result: 'activated' }
  | { result: 'wrong_pin'; retryAt?: number }
  | { result: 'refused'; retryAt: number }
  | { result: 'unavailable' }
  | OperationFailure;

export interface BackupService {
  estimate(): Promise<BackupEstimate>;
  /** 24 words; shown once, then confirmed by a three-word challenge. */
  generateRecoveryKey(): Promise<string[]>;
  /** Platform CSPRNG bytes (the challenge positions). */
  randomBytes(count: number): Uint8Array;
  /** Writes and verifies the archive in app-private storage; no picker. */
  prepare(
    kind: SecretKind,
    secret: string,
    excludeEntryIds: readonly string[],
  ): Promise<PreparedBackup>;
  /** Opens the system save picker; wrap it in the lock grace. */
  save(suggestedName: string): Promise<SavedBackup>;
  cancel(): void;
  discard(): Promise<void>;
  restoreTarget(): Promise<RestoreTargetCounts>;
  /** Opens the system file picker; wrap it in the lock grace. */
  pickArchive(): Promise<PickedArchive>;
  openArchive(secret: string): Promise<OpenedArchive>;
  stage(): Promise<{ status: 'staged' } | OperationFailure>;
  /** Needs the current PIN; the vault ends locked on success. */
  activate(pin: string): Promise<Activation>;
  abandon(): Promise<void>;
}
