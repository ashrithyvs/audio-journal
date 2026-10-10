// Ordered schema migrations (LLD §3). A migration is never edited after it
// ships: the runner stores each one's checksum and refuses a changed history.
// AJ-1 creates only the source tables; derivation, task, and provenance tables
// arrive with the frozen `journal.organize@1` contract in AJ-2.

export interface Migration {
  version: number;
  name: string;
  statements: readonly string[];
}

const ID = 'TEXT NOT NULL CHECK (length(id) = 30)';

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'aj1_source_tables',
    statements: [
      `CREATE TABLE journal_entries (
        id ${ID} PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('voice', 'written')),
        status TEXT NOT NULL
          CHECK (status IN ('draft', 'ready', 'recovery_required', 'deleted')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        title TEXT CHECK (title IS NULL OR length(title) <= 200),
        source_text TEXT CHECK (source_text IS NULL OR length(source_text) <= 200000),
        CHECK ((kind = 'written') = (source_text IS NOT NULL))
      ) STRICT`,
      `CREATE INDEX journal_entries_timeline
        ON journal_entries (created_at DESC, id DESC)
        WHERE status IN ('ready', 'recovery_required')`,
      `CREATE TABLE recordings (
        id ${ID} PRIMARY KEY,
        entry_id TEXT NOT NULL UNIQUE REFERENCES journal_entries (id),
        relative_path TEXT NOT NULL UNIQUE
          CHECK (relative_path = 'recordings/' || id || '.ajr'),
        state TEXT NOT NULL CHECK (state IN ('preparing', 'recording', 'paused',
          'finalizing', 'ready', 'recoverable', 'failed')),
        format TEXT NOT NULL CHECK (format = 'AJR1/pcm_s16le/16000/1'),
        started_at INTEGER NOT NULL,
        ended_at INTEGER CHECK (ended_at IS NULL OR ended_at >= started_at),
        duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
        sealed_chunks INTEGER NOT NULL DEFAULT 0 CHECK (sealed_chunks >= 0),
        byte_count INTEGER NOT NULL DEFAULT 0 CHECK (byte_count >= 0),
        content_sha256 TEXT CHECK (content_sha256 IS NULL
          OR (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*')),
        finish_reason TEXT CHECK (finish_reason IS NULL OR finish_reason IN
          ('user', 'duration_limit', 'storage_low', 'recovered')),
        CHECK (state <> 'ready' OR (ended_at IS NOT NULL
          AND content_sha256 IS NOT NULL AND finish_reason IS NOT NULL
          AND sealed_chunks > 0))
      ) STRICT`,
      // A finalized recording is the source of truth (ADR-002): frozen.
      `CREATE TRIGGER recordings_ready_immutable
        BEFORE UPDATE ON recordings WHEN OLD.state = 'ready'
        BEGIN SELECT RAISE(ABORT, 'finalized recordings are immutable'); END`,
      `CREATE TRIGGER recordings_no_delete
        BEFORE DELETE ON recordings
        BEGIN SELECT RAISE(ABORT, 'recordings are not deleted in AJ-1'); END`,
      `CREATE TABLE transcript_segments (
        id ${ID} PRIMARY KEY,
        entry_id TEXT NOT NULL REFERENCES journal_entries (id),
        recording_id TEXT NOT NULL REFERENCES recordings (id),
        engine_revision INTEGER NOT NULL CHECK (engine_revision >= 0),
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
        end_ms INTEGER NOT NULL CHECK (end_ms >= start_ms),
        text TEXT NOT NULL CHECK (length(text) <= 4000),
        state TEXT NOT NULL CHECK (state IN ('provisional', 'final', 'corrected')),
        source TEXT NOT NULL CHECK (source IN ('engine', 'user')),
        model_id TEXT,
        supersedes_segment_id TEXT UNIQUE REFERENCES transcript_segments (id),
        superseded_at INTEGER,
        created_at INTEGER NOT NULL,
        CHECK (superseded_at IS NULL OR state = 'provisional'),
        CHECK ((state = 'corrected') = (source = 'user')),
        CHECK ((state = 'corrected') = (supersedes_segment_id IS NOT NULL)),
        CHECK ((state = 'provisional') = (engine_revision = 0)),
        CHECK ((state = 'final') = (model_id IS NOT NULL))
      ) STRICT`,
      `CREATE UNIQUE INDEX transcript_engine_ordinal
        ON transcript_segments (recording_id, engine_revision, ordinal)
        WHERE state = 'final'`,
      `CREATE INDEX transcript_by_recording
        ON transcript_segments (recording_id, engine_revision)`,
      // Engine and user rows are append-only. Live rows may be revised until
      // superseded (by the full pass or a later window), then are frozen and
      // kept: retention and compaction await an ADR (Open decision 6).
      `CREATE TRIGGER transcript_segments_append_only
        BEFORE UPDATE ON transcript_segments
        WHEN OLD.state <> 'provisional' OR OLD.superseded_at IS NOT NULL
          OR NEW.id IS NOT OLD.id OR NEW.state IS NOT OLD.state
          OR NEW.recording_id IS NOT OLD.recording_id
          OR NEW.entry_id IS NOT OLD.entry_id
        BEGIN SELECT RAISE(ABORT, 'transcript segments are append-only'); END`,
      `CREATE TRIGGER transcript_segments_no_delete
        BEFORE DELETE ON transcript_segments
        BEGIN SELECT RAISE(ABORT, 'transcript segments are append-only'); END`,
      // Bounds live text per recording (TRANSCRIPT_LIMITS.maxProvisionalSegments).
      // An upsert of an existing row also fires BEFORE INSERT; it is exempt.
      `CREATE TRIGGER transcript_provisional_bound
        BEFORE INSERT ON transcript_segments WHEN NEW.state = 'provisional'
          AND NOT EXISTS (SELECT 1 FROM transcript_segments WHERE id = NEW.id)
          AND (SELECT count(*) FROM transcript_segments
            WHERE recording_id = NEW.recording_id AND engine_revision = 0) >= 4000
        BEGIN SELECT RAISE(ABORT, 'provisional segment limit'); END`,
      `CREATE TABLE app_settings (
        key TEXT NOT NULL PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 64),
        value TEXT NOT NULL CHECK (length(value) <= 4096)
      ) STRICT`,
    ],
  },
  {
    version: 2,
    name: 'aj1_transcript_passes',
    statements: [
      // One row per completed full pass, empty passes included, so a silent
      // recording is not transcribed again after every unlock (ADR-017,
      // owner decision 2026-10-10: final passes restart after unlock).
      `CREATE TABLE transcript_passes (
        recording_id TEXT NOT NULL REFERENCES recordings (id),
        engine_revision INTEGER NOT NULL CHECK (engine_revision > 0),
        model_id TEXT NOT NULL,
        segment_count INTEGER NOT NULL CHECK (segment_count >= 0),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (recording_id, engine_revision)
      ) STRICT`,
      // Passes stored before this table existed.
      `INSERT INTO transcript_passes
        (recording_id, engine_revision, model_id, segment_count, created_at)
        SELECT recording_id, engine_revision, max(model_id), count(*), min(created_at)
          FROM transcript_segments
          WHERE engine_revision > 0 AND state = 'final'
          GROUP BY recording_id, engine_revision`,
      `CREATE TRIGGER transcript_passes_append_only
        BEFORE UPDATE ON transcript_passes
        BEGIN SELECT RAISE(ABORT, 'transcript passes are append-only'); END`,
      `CREATE TRIGGER transcript_passes_no_delete
        BEFORE DELETE ON transcript_passes
        BEGIN SELECT RAISE(ABORT, 'transcript passes are append-only'); END`,
    ],
  },
];

/** Deterministic, dependency-free fingerprint; detects edits, not attacks. */
/* eslint-disable no-bitwise -- a 64-bit string hash (cyrb53 mixing). */
export function migrationChecksum(migration: Migration): string {
  const text = `${migration.version}\n${migration.name}\n${migration.statements
    .map(statement => statement.replace(/\s+/g, ' ').trim())
    .join(';\n')}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (
    (h2 >>> 0).toString(16).padStart(8, '0') +
    (h1 >>> 0).toString(16).padStart(8, '0')
  );
}
/* eslint-enable no-bitwise */
