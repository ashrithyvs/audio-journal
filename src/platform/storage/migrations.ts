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
  {
    // journal.organize@1 (ADR-019, contract §7): immutable derivation
    // revisions, their scope, tasks, and source references. Only a task's
    // state is application data that may change.
    version: 3,
    name: 'aj2_derivations',
    statements: [
      `CREATE TABLE derivations (
        id ${ID} PRIMARY KEY CHECK (substr(id, 1, 4) = 'drv_'),
        request_key TEXT NOT NULL UNIQUE
          CHECK (length(request_key) = 30 AND substr(request_key, 1, 4) = 'org_'),
        contract TEXT NOT NULL CHECK (contract = 'journal.organize@1'),
        engine_id TEXT NOT NULL CHECK (length(engine_id) BETWEEN 1 AND 32),
        engine_version TEXT NOT NULL CHECK (length(engine_version) BETWEEN 5 AND 11),
        input_sha256 TEXT NOT NULL CHECK (length(input_sha256) = 64),
        scope_key TEXT NOT NULL CHECK (length(scope_key) BETWEEN 30 AND 619),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        payload TEXT NOT NULL CHECK (length(CAST(payload AS BLOB)) <= 61387),
        created_at INTEGER NOT NULL,
        UNIQUE (scope_key, revision)
      ) STRICT`,
      `CREATE TABLE derivation_entries (
        derivation_id TEXT NOT NULL REFERENCES derivations(id),
        entry_id TEXT NOT NULL REFERENCES journal_entries(id),
        PRIMARY KEY (derivation_id, entry_id)
      ) STRICT`,
      `CREATE INDEX derivation_entries_entry ON derivation_entries(entry_id)`,
      `CREATE TABLE derived_tasks (
        id ${ID} PRIMARY KEY CHECK (substr(id, 1, 4) = 'tsk_'),
        derivation_id TEXT NOT NULL REFERENCES derivations(id),
        ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 49),
        text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 400),
        area TEXT NOT NULL CHECK (area IN ('work', 'personal', 'unsorted')),
        state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'done', 'dismissed')),
        state_changed_at INTEGER,
        UNIQUE (derivation_id, ordinal)
      ) STRICT`,
      `CREATE TABLE source_references (
        id ${ID} PRIMARY KEY CHECK (substr(id, 1, 4) = 'src_'),
        derivation_id TEXT NOT NULL REFERENCES derivations(id),
        item_kind TEXT NOT NULL
          CHECK (item_kind IN ('summary', 'work', 'personal', 'task', 'idea', 'person', 'project')),
        item_ordinal INTEGER NOT NULL CHECK (item_ordinal BETWEEN 0 AND 49),
        ref_ordinal INTEGER NOT NULL CHECK (ref_ordinal BETWEEN 0 AND 7),
        entry_id TEXT NOT NULL REFERENCES journal_entries(id),
        unit_id TEXT NOT NULL CHECK (length(unit_id) BETWEEN 2 AND 30),
        unit_sha256 TEXT NOT NULL CHECK (length(unit_sha256) = 64),
        segment_id TEXT REFERENCES transcript_segments(id),
        char_start INTEGER NOT NULL CHECK (char_start >= 0),
        char_end INTEGER NOT NULL CHECK (char_end > char_start AND char_end <= 4000),
        audio_start_ms INTEGER,
        audio_end_ms INTEGER,
        CHECK ((audio_start_ms IS NULL) = (audio_end_ms IS NULL)),
        CHECK (audio_start_ms IS NULL OR (audio_start_ms >= 0 AND audio_start_ms < audio_end_ms)),
        CHECK ((segment_id IS NULL) = (audio_start_ms IS NULL)),
        UNIQUE (derivation_id, item_kind, item_ordinal, ref_ordinal)
      ) STRICT`,
      `CREATE INDEX source_references_entry ON source_references(entry_id)`,
      `CREATE TRIGGER derivations_immutable
        BEFORE UPDATE ON derivations
        BEGIN SELECT RAISE(ABORT, 'derivations are immutable'); END`,
      `CREATE TRIGGER derivations_kept
        BEFORE DELETE ON derivations
        BEGIN SELECT RAISE(ABORT, 'derivations are kept'); END`,
      `CREATE TRIGGER derivation_entries_immutable
        BEFORE UPDATE ON derivation_entries
        BEGIN SELECT RAISE(ABORT, 'derivation scope is immutable'); END`,
      `CREATE TRIGGER derivation_entries_kept
        BEFORE DELETE ON derivation_entries
        BEGIN SELECT RAISE(ABORT, 'derivation scope is kept'); END`,
      `CREATE TRIGGER source_references_immutable
        BEFORE UPDATE ON source_references
        BEGIN SELECT RAISE(ABORT, 'source references are immutable'); END`,
      `CREATE TRIGGER source_references_kept
        BEFORE DELETE ON source_references
        BEGIN SELECT RAISE(ABORT, 'source references are kept'); END`,
      `CREATE TRIGGER derived_tasks_content_immutable
        BEFORE UPDATE OF id, derivation_id, ordinal, text, area ON derived_tasks
        BEGIN SELECT RAISE(ABORT, 'derived task content is immutable'); END`,
      `CREATE TRIGGER derived_tasks_kept
        BEFORE DELETE ON derived_tasks
        BEGIN SELECT RAISE(ABORT, 'derived tasks are kept'); END`,
      // The request-key secret (contract §9): one random key per journal,
      // kept out of app_settings and never carried by backups.
      `CREATE TABLE organize_secret (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        key_hex TEXT NOT NULL CHECK (length(key_hex) = 64 AND key_hex NOT GLOB '*[^0-9a-f]*')
      ) STRICT`,
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
