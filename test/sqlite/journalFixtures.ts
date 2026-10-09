import {
  createIdSource,
  type IdSource,
} from '../../src/features/journal/domain/ids';
import { migrate } from '../../src/platform/storage/migrationRunner';
import { SqliteJournalRepository } from '../../src/platform/storage/SqliteJournalRepository';
import { SqliteTranscriptRepository } from '../../src/platform/storage/SqliteTranscriptRepository';
import { NodeSqliteDatabase } from './NodeSqliteDatabase';

/** Deterministic, collision-free IDs: a counter spread over 16 bytes. */
export function sequentialIds(seed = 1): IdSource {
  let counter = seed;
  return createIdSource(length => {
    const bytes = new Uint8Array(length);
    let value = counter;
    counter += 1;
    for (let index = length - 1; index >= 0 && value > 0; index -= 1) {
      bytes[index] = value % 256;
      value = Math.floor(value / 256);
    }
    bytes[0] = seed % 256;
    return bytes;
  });
}

export const SHA_A = 'a'.repeat(64);

export async function openJournal(location = ':memory:', seed = 1) {
  const db = new NodeSqliteDatabase(location);
  await migrate(db, 1_700_000_000_000);
  const ids = sequentialIds(seed);
  return {
    db,
    ids,
    journal: new SqliteJournalRepository(db),
    transcripts: new SqliteTranscriptRepository(db, ids),
  };
}

/** A finalized voice entry with `durationMs` of audio. */
export async function readyVoiceEntry(
  context: Awaited<ReturnType<typeof openJournal>>,
  durationMs: number,
  startedAt = 1_700_000_100_000,
) {
  const entryId = context.ids.next('ent');
  const recordingId = context.ids.next('rec');
  await context.journal.createVoiceDraft({ entryId, recordingId, startedAt });
  await context.journal.finalizeVoice({
    recordingId,
    endedAt: startedAt + durationMs,
    durationMs,
    sealedChunks: Math.max(1, Math.ceil(durationMs / 1000)),
    byteCount: durationMs * 32 + 64,
    contentSha256: SHA_A,
    finishReason: 'user',
  });
  return { entryId, recordingId };
}
