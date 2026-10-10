import NativeAudioJournalStore from '../native/NativeAudioJournalStore';
import type { JournalServices } from '../features/journal/application/JournalContext';
import { reconcileRecordings } from '../features/journal/application/startupReconciliation';
import { UnavailableRecordingService } from '../features/journal/adapters/UnavailableRecordingService';
import { createIdSource } from '../features/journal/domain/ids';
import { migrate } from '../platform/storage/migrationRunner';
import { openNativeJournalDatabase } from '../platform/storage/NativeSqlDriver';
import { SqliteJournalRepository } from '../platform/storage/SqliteJournalRepository';
import { SqliteTranscriptRepository } from '../platform/storage/SqliteTranscriptRepository';

export interface OpenedJournal {
  services: JournalServices;
  close(): Promise<void>;
}

/**
 * Opens the unlocked journal (LLD §9): the SQLCipher database, transactional
 * migrations, then startup reconciliation. A migration failure rejects with
 * MIGRATION_FAILED and changes nothing; the gate shows a recoverable error.
 */
export async function openProductionJournal(): Promise<OpenedJournal> {
  const store = NativeAudioJournalStore;
  if (!store) {
    throw new Error('STORE_UNAVAILABLE');
  }
  const db = await openNativeJournalDatabase(store);
  try {
    await migrate(db, Date.now());
  } catch (error) {
    await db.close();
    throw error;
  }
  const ids = createIdSource(length =>
    Uint8Array.from(store.randomBytesHex(length).match(/../g) ?? [], byte =>
      parseInt(byte, 16),
    ),
  );
  const journal = new SqliteJournalRepository(db);
  const recorder = new UnavailableRecordingService();
  // Skipped while there is no recorder: an absent scanner is not missing files.
  await reconcileRecordings(journal, recorder, Date.now).catch(() => undefined);
  return {
    services: {
      journal,
      transcripts: new SqliteTranscriptRepository(db, ids),
      recorder,
      ids,
    },
    close: () => db.close(),
  };
}
