import type { CodegenTypes, TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

// Native AJB1 backup and restore (ADR-017, backup-and-restore.md §9). Journal
// content, PCM, and keys stay native; results are JSON strings carrying
// counts, sizes, typed codes, and (for damaged entries) local labels only.
// The system pickers run only inside `saveBackup` and `pickArchive`, so the
// caller can hold the lock grace for exactly that long.
export interface Spec extends TurboModule {
  /** Phases only; never content. */
  readonly onBackupProgress: CodegenTypes.EventEmitter<{
    operation: string;
    phase: string;
  }>;
  /** Pass 1 without a secret: counts, sizes, free space, damaged entries. */
  readonly estimateBackup: () => Promise<string>;
  /** 24 words for a new recovery key (§9.7). */
  readonly generateRecoveryKey: () => Promise<string>;
  /** Writes and verifies the archive in app-private cache; no picker. */
  readonly prepareBackup: (
    secretKind: string,
    secret: string,
    excludeJson: string,
  ) => Promise<string>;
  /** Save picker, copy, and destination verification. */
  readonly saveBackup: (suggestedName: string) => Promise<string>;
  readonly cancelBackup: () => void;
  readonly discardBackup: () => Promise<void>;
  /** Counts for the "empty journal" rule. */
  readonly restoreTarget: () => Promise<string>;
  /** Open picker and the checks that need no secret. */
  readonly pickArchive: () => Promise<string>;
  /** KDF, full authentication, and the manifest preview. */
  readonly openArchive: (secret: string) => Promise<string>;
  /** Streams the archive into a staging vault. */
  readonly stageRestore: () => Promise<string>;
  /** Current PIN, then crash-safe activation; the vault ends locked. */
  readonly activateRestore: (pin: string) => Promise<string>;
  readonly abandonRestore: () => Promise<void>;
}

export default TurboModuleRegistry.get<Spec>('AudioJournalBackup');
