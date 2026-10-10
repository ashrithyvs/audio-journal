package com.audiojournal.backup

import android.database.Cursor
import com.audiojournal.vault.VaultCrypto
import java.io.File
import net.zetetic.database.sqlcipher.SQLiteDatabase

/**
 * The export snapshot (§9.10 step 1): a separate read-only SQLCipher
 * connection in one read transaction. WAL gives it a consistent view for both
 * passes without blocking the journal's own writer. Rows map to the §9.6
 * records; what is not exported never leaves the database.
 */
class SqlJournalSnapshot private constructor(private val db: SQLiteDatabase) :
    JournalSnapshot, AutoCloseable {

  companion object {
    /** [databaseKey] is the raw `aj-db-v1` key; the caller zeroes it. */
    fun open(file: File, databaseKey: ByteArray): SqlJournalSnapshot {
      val password =
          "x'${databaseKey.joinToString("") { "%02x".format(it) }}'".toByteArray(Charsets.US_ASCII)
      try {
        val db =
            SQLiteDatabase.openDatabase(file.path, password, null, SQLiteDatabase.OPEN_READONLY, null, null)
        db.beginTransactionReadOnly()
        return SqlJournalSnapshot(db)
      } finally {
        VaultCrypto.zero(password)
      }
    }

    private const val EXPORTED_RECORDING =
        "r.state IN ('ready', 'recoverable') AND e.status IN ('ready', 'recovery_required')"
  }

  private fun Cursor.long(column: String) = getLong(getColumnIndexOrThrow(column))

  private fun Cursor.string(column: String) = getString(getColumnIndexOrThrow(column))

  private fun Cursor.optionalLong(column: String) =
      getColumnIndexOrThrow(column).let { if (isNull(it)) null else getLong(it) }

  private fun Cursor.optionalString(column: String) =
      getColumnIndexOrThrow(column).let { if (isNull(it)) null else getString(it) }

  override fun recordings(): List<SnapshotRecording> =
      db.rawQuery(
              """SELECT r.id, r.entry_id, r.state, r.started_at, r.ended_at, r.duration_ms,
                   r.finish_reason, r.content_sha256
                 FROM recordings r JOIN journal_entries e ON e.id = r.entry_id
                 WHERE $EXPORTED_RECORDING ORDER BY r.id""",
              emptyArray<String>())
          .use { cursor ->
            val out = ArrayList<SnapshotRecording>()
            while (cursor.moveToNext()) {
              out.add(
                  SnapshotRecording(
                      cursor.string("id"),
                      cursor.string("entry_id"),
                      cursor.string("state"),
                      cursor.long("started_at"),
                      cursor.optionalLong("ended_at"),
                      cursor.long("duration_ms"),
                      cursor.optionalString("finish_reason"),
                      cursor.optionalString("content_sha256")))
            }
            out
          }

  override fun forEachEntry(exclude: Set<String>, visit: (Map<String, Any>) -> Unit) {
    db.rawQuery(
            """SELECT id, kind, status, created_at, updated_at, title, source_text
               FROM journal_entries e
               WHERE status IN ('ready', 'recovery_required')
                 AND (kind = 'written' OR EXISTS (SELECT 1 FROM recordings r
                   WHERE r.entry_id = e.id AND r.state IN ('ready', 'recoverable')))
               ORDER BY id""",
            emptyArray<String>())
        .use { cursor ->
          while (cursor.moveToNext()) {
            val id = cursor.string("id")
            if (id in exclude) continue
            val record =
                linkedMapOf<String, Any>(
                    "t" to "entry",
                    "id" to id,
                    "kind" to cursor.string("kind"),
                    "status" to cursor.string("status"),
                    "createdAtMs" to cursor.long("created_at"),
                    "updatedAtMs" to cursor.long("updated_at"))
            cursor.optionalString("title")?.let { record["title"] = it }
            cursor.optionalString("source_text")?.let { record["sourceText"] = it }
            visit(record)
          }
        }
  }

  override fun forEachSegment(exclude: Set<String>, visit: (Map<String, Any>) -> Unit) {
    // Live rows travel only where no full pass exists and they were not
    // superseded (§9.6).
    db.rawQuery(
            """SELECT s.* FROM transcript_segments s
               JOIN recordings r ON r.id = s.recording_id
               JOIN journal_entries e ON e.id = r.entry_id
               WHERE $EXPORTED_RECORDING
                 AND (s.state IN ('final', 'corrected')
                   OR (s.state = 'provisional' AND s.superseded_at IS NULL
                     AND NOT EXISTS (SELECT 1 FROM transcript_segments f
                       WHERE f.recording_id = s.recording_id AND f.engine_revision > 0)))
               ORDER BY s.id""",
            emptyArray<String>())
        .use { cursor ->
          while (cursor.moveToNext()) {
            val entryId = cursor.string("entry_id")
            if (entryId in exclude) continue
            val record =
                linkedMapOf<String, Any>(
                    "t" to "transcriptSegment",
                    "id" to cursor.string("id"),
                    "entryId" to entryId,
                    "recordingId" to cursor.string("recording_id"),
                    "engineRevision" to cursor.long("engine_revision"),
                    "ordinal" to cursor.long("ordinal"),
                    "startMs" to cursor.long("start_ms"),
                    "endMs" to cursor.long("end_ms"),
                    "text" to cursor.string("text"),
                    "state" to cursor.string("state"),
                    "source" to cursor.string("source"),
                    "createdAtMs" to cursor.long("created_at"))
            cursor.optionalString("model_id")?.let { record["modelId"] = it }
            cursor.optionalString("supersedes_segment_id")?.let { record["supersedesSegmentId"] = it }
            visit(record)
          }
        }
  }

  /** Local labels (date, title) for the damaged-entry list shown to the user. */
  fun labels(entryIds: Collection<String>): Map<String, Pair<Long, String?>> {
    val out = HashMap<String, Pair<Long, String?>>()
    for (id in entryIds) {
      db.rawQuery("SELECT created_at, title FROM journal_entries WHERE id = ?", arrayOf(id)).use {
        if (it.moveToFirst()) out[id] = it.getLong(0) to (if (it.isNull(1)) null else it.getString(1))
      }
    }
    return out
  }

  override fun close() {
    try {
      db.endTransaction()
    } finally {
      db.close()
    }
  }
}
