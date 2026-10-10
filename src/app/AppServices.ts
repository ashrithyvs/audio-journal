import type { AppLockServices } from '../features/app-lock/application/AppLockContext';
import type { BackupService } from '../features/backup/ports/BackupService';
import NativeAudioJournalBackup from '../native/NativeAudioJournalBackup';
import NativeAudioJournalStore from '../native/NativeAudioJournalStore';
import { NativeBackupService } from '../platform/backup/NativeBackupService';
import type { PrivateNodeOptions } from '../features/private-node/application/PrivateNodeContext';
import type { HybridAiGateway } from '../platform/hybrid-ai/HybridAiGateway';
import { PackagedHybridAiGateway } from '../platform/hybrid-ai/PackagedHybridAiGateway';
import { NativeVaultService } from '../platform/vault/NativeVaultService';
import {
  openProductionJournal,
  type JournalOpenContext,
  type OpenedJournal,
} from './openJournal';

export interface AppServices {
  appLock: AppLockServices;
  hybridAI: HybridAiGateway;
  privateNode?: PrivateNodeOptions;
  /** Opens the journal after each unlock (ADR-017); closed on lock. */
  openJournal: (context: JournalOpenContext) => Promise<OpenedJournal>;
  /** Encrypted backup and restore; absent without the native codec. */
  backup?: BackupService;
}

/** Platform CSPRNG bytes from the native store module. */
function nativeRandomBytes(count: number): Uint8Array {
  const hex = NativeAudioJournalStore?.randomBytesHex(count) ?? '';
  if (hex.length !== count * 2) {
    throw new Error('RANDOM_UNAVAILABLE');
  }
  return Uint8Array.from(hex.match(/../g) ?? [], byte => parseInt(byte, 16));
}

/**
 * Production services. `modelDirectory` comes from the Android launch props:
 * the app-provisioned Hybrid AI local model directory (ADR-015). The lock is
 * the native ADR-017 vault; without it, the lock fails closed.
 */
export function createDefaultAppServices(modelDirectory?: string): AppServices {
  return {
    appLock: { vault: new NativeVaultService() },
    hybridAI: new PackagedHybridAiGateway(modelDirectory),
    openJournal: openProductionJournal,
    backup: NativeAudioJournalBackup
      ? new NativeBackupService(NativeAudioJournalBackup, nativeRandomBytes)
      : undefined,
  };
}
