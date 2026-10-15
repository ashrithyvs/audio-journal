import NativeAudioJournalRecordings from '../native/NativeAudioJournalRecordings';
import NativeAudioJournalSpeech from '../native/NativeAudioJournalSpeech';
import NativeAudioJournalStore from '../native/NativeAudioJournalStore';
import type { JournalServices } from '../features/journal/application/JournalContext';
import { reconcileRecordings } from '../features/journal/application/startupReconciliation';
import { UnavailableRecordingService } from '../features/journal/adapters/UnavailableRecordingService';
import { createIdSource } from '../features/journal/domain/ids';
import type { OrganizeServices } from '../features/organize/application/OrganizeContext';
import { NativeRecordingTranscriber } from '../features/transcription/adapters/NativeRecordingTranscriber';
import { migrate } from '../platform/storage/migrationRunner';
import { openNativeJournalDatabase } from '../platform/storage/NativeSqlDriver';
import { SqliteDerivationRepository } from '../platform/storage/SqliteDerivationRepository';
import { SqliteJournalRepository } from '../platform/storage/SqliteJournalRepository';
import { SqliteTranscriptRepository } from '../platform/storage/SqliteTranscriptRepository';
import { NativePlaybackService } from '../platform/recording/NativePlaybackService';
import {
  NativeRecordingService,
  requestAndroidMicrophone,
} from '../platform/recording/NativeRecordingService';

export interface OpenedJournal {
  services: JournalServices;
  /** journal.organize@1 storage and platform digests (ADR-019). */
  organize?: OrganizeServices;
  close(): Promise<void>;
}

/** What the unlocked shell lends the journal while it is open. */
export interface JournalOpenContext {
  /** Lock grace while the app's own system UI is open (ADR-017). */
  expectSystemUi(): () => void;
}

/**
 * Opens the unlocked journal (LLD §9): the SQLCipher database, transactional
 * migrations, then startup reconciliation. A migration failure rejects with
 * MIGRATION_FAILED and changes nothing; the gate shows a recoverable error.
 */
export async function openProductionJournal(
  context: JournalOpenContext,
): Promise<OpenedJournal> {
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
  const audio = NativeAudioJournalRecordings;
  const native = audio
    ? new NativeRecordingService(audio, () =>
        requestAndroidMicrophone(context.expectSystemUi),
      )
    : undefined;
  const recorder = native ?? new UnavailableRecordingService();
  const playback = audio ? new NativePlaybackService(audio) : undefined;
  const speech = audio ? NativeAudioJournalSpeech : null;
  if (native) {
    // A failure leaves rows as they were; the next unlock plans again.
    await reconcileRecordings(journal, native, Date.now).catch(() => undefined);
  }
  return {
    services: {
      journal,
      transcripts: new SqliteTranscriptRepository(db, ids),
      recorder,
      playback,
      // Final passes over sealed recordings through the packaged Hybrid AI
      // SDK (AJ ADR-022). No live text: GRI-2L stopped (AJ-RI2-DEC-001).
      transcriber: speech ? new NativeRecordingTranscriber(speech) : undefined,
      ids,
    },
    organize: {
      derivations: new SqliteDerivationRepository(db, ids),
      crypto: {
        sha256Hex: text => store.sha256Hex(text),
        hmacSha256Hex: (keyHex, label, text) =>
          store.hmacSha256Hex(keyHex, label, text),
      },
      randomHex: count => store.randomBytesHex(count),
    },
    close: async () => {
      native?.detach();
      await playback?.stop().catch(() => undefined);
      await db.close();
    },
  };
}
