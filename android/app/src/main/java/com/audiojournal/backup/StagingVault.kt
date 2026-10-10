package com.audiojournal.backup

import com.audiojournal.recording.Ajr1
import com.audiojournal.recording.Ajr1Writer
import com.audiojournal.vault.VaultCrypto
import java.io.File
import net.zetetic.database.sqlcipher.SQLiteDatabase

/** The live journal's schema, so migrations exist only in JavaScript. */
class JournalSchema(
    /** `sqlite_master` DDL in creation order, internal objects excluded. */
    val statements: List<String>,
    /** `schema_migrations` rows: version, name, checksum, applied_at. */
    val history: List<List<Any>>,
)

/**
 * A restore staging vault (§9.10 restore steps 2–5). It has a fresh
 * in-memory master key, its own SQLCipher database with the live schema, and
 * AJR1 recordings re-encrypted under that key. Nothing in it is readable
 * once the process ends without activating, because the key dies with it.
 * The whole import is one transaction with deferred foreign keys; recording
 * rows are written once their file is complete.
 */
class StagingVault(restoreDir: File, schema: JournalSchema) : ArchiveSink, AutoCloseable {
  val name = "staging-" + Ajb1.hex(VaultCrypto.randomBytes(16))
  val dir = File(restoreDir, name)
  private var masterKey: ByteArray? = VaultCrypto.randomBytes(VaultCrypto.KEY_BYTES)
  private val recordingRoot = VaultCrypto.hkdf(masterKey!!, "aj-rec-v1")
  private val db: SQLiteDatabase
  private val chunk = ByteArray(Ajr1.MAX_CHUNK_BYTES)
  private var filled = 0
  private var writer: Ajr1Writer? = null
  private var frames = 0
  private var finished = false

  init {
    val journal = File(dir, "journal").apply { mkdirs() }
    File(dir, "recordings").mkdirs()
    val key = VaultCrypto.hkdf(masterKey!!, "aj-db-v1")
    val password = "x'${key.joinToString("") { "%02x".format(it) }}'".toByteArray(Charsets.US_ASCII)
    try {
      db = SQLiteDatabase.openOrCreateDatabase(File(journal, "journal.db").path, password, null, null, null)
    } finally {
      VaultCrypto.zero(key, password)
    }
    db.setForeignKeyConstraintsEnabled(true)
    db.beginTransaction()
    for (statement in schema.statements) db.execSQL(statement)
    for (row in schema.history) {
      db.execSQL(
          "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
          row.toTypedArray())
    }
    db.execSQL("PRAGMA defer_foreign_keys = ON")
  }

  override fun record(record: Map<String, Any>) {
    when (record["t"]) {
      "entry" ->
          db.execSQL(
              """INSERT INTO journal_entries (id, kind, status, created_at, updated_at, title, source_text)
                 VALUES (?, ?, ?, ?, ?, ?, ?)""",
              arrayOf(
                  record["id"], record["kind"], record["status"], record["createdAtMs"],
                  record["updatedAtMs"], record["title"], record["sourceText"]))
      "recording" -> Unit // written at recordingEnd, with its file's frame count and length
      else ->
          db.execSQL(
              """INSERT INTO transcript_segments (id, entry_id, recording_id, engine_revision, ordinal,
                   start_ms, end_ms, text, state, source, model_id, supersedes_segment_id, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
              arrayOf(
                  record["id"], record["entryId"], record["recordingId"], record["engineRevision"],
                  record["ordinal"], record["startMs"], record["endMs"], record["text"], record["state"],
                  record["source"], record["modelId"], record["supersedesSegmentId"], record["createdAtMs"]))
    }
  }

  override fun recordingStart(recording: Map<String, Any>) {
    val id = recording["id"] as String
    writer =
        Ajr1Writer.create(File(dir, "recordings/$id.ajr"), id, recordingRoot, syncEachFrame = false)
    frames = 0
    filled = 0
  }

  override fun pcm(bytes: ByteArray, offset: Int, length: Int) {
    var at = offset
    while (at < offset + length) {
      val take = minOf(chunk.size - filled, offset + length - at)
      System.arraycopy(bytes, at, chunk, filled, take)
      filled += take
      at += take
      if (filled == chunk.size) seal()
    }
  }

  private fun seal() {
    if (filled == 0) return
    val pcm = chunk.copyOf(filled)
    try {
      writer!!.append(pcm)
    } finally {
      VaultCrypto.zero(pcm)
      chunk.fill(0)
    }
    frames += 1
    filled = 0
  }

  override fun recordingEnd(recording: Map<String, Any>) {
    seal() // PCM bytes are even (§9.6), so the last chunk is whole samples
    val current = writer!!
    current.close()
    val id = recording["id"] as String
    db.execSQL(
        """INSERT INTO recordings (id, entry_id, relative_path, state, format, started_at, ended_at,
             duration_ms, sealed_chunks, byte_count, content_sha256, finish_reason)
           VALUES (?, ?, ?, ?, 'AJR1/pcm_s16le/16000/1', ?, ?, ?, ?, ?, ?, ?)""",
        arrayOf(
            id, recording["entryId"], "recordings/$id.ajr", recording["state"], recording["startedAtMs"],
            recording["endedAtMs"], recording["durationMs"], frames, current.fileBytes,
            recording["pcmSha256"], recording["finishReason"]))
    writer = null
  }

  /** The archive read to its end: commit, then the vault can be activated. */
  fun commit() {
    db.setTransactionSuccessful()
    db.endTransaction() // deferred foreign keys are checked here
    db.close()
    finished = true
  }

  /** The new vault's master key for activation; the caller zeroes its copy. */
  fun masterKey(): ByteArray = masterKey?.copyOf() ?: throw IllegalStateException("STAGING_CLOSED")

  /** Discards everything staged (cancel, failure, or after activation). */
  override fun close() {
    writer?.close()
    writer = null
    if (!finished) {
      runCatching { if (db.inTransaction()) db.endTransaction() }
      runCatching { db.close() }
    }
    chunk.fill(0)
    VaultCrypto.zero(masterKey, recordingRoot)
    masterKey = null
  }

  /** Removes the staging directory (it holds only unreadable ciphertext). */
  fun delete() {
    dir.deleteRecursively()
  }

  companion object {
    /** Reads the live schema inside the journal's own database thread. */
    fun schemaOf(db: SQLiteDatabase): JournalSchema {
      val statements = ArrayList<String>()
      db.rawQuery(
              "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
              emptyArray<String>())
          .use { cursor -> while (cursor.moveToNext()) statements.add(cursor.getString(0)) }
      val history = ArrayList<List<Any>>()
      db.rawQuery(
              "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version",
              emptyArray<String>())
          .use { cursor ->
            while (cursor.moveToNext()) {
              history.add(listOf(cursor.getLong(0), cursor.getString(1), cursor.getString(2), cursor.getLong(3)))
            }
          }
      return JournalSchema(statements, history)
    }
  }
}
