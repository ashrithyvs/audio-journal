package com.audiojournal.store

import android.content.Context
import android.database.Cursor
import com.audiojournal.vault.Vault
import com.audiojournal.vault.VaultCrypto
import java.io.File
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import net.zetetic.database.sqlcipher.SQLiteDatabase
import org.json.JSONArray
import org.json.JSONObject

/**
 * The encrypted journal database (ADR-017): SQLCipher in WAL mode, keyed with
 * the raw HKDF-SHA256 database key (`aj-db-v1`), in no-backup storage. Every
 * operation, including close on lock, runs on one thread: Android SQLite
 * transactions are thread-bound, and lock must not race a query.
 */
object JournalDatabase {
  const val DB_KEY_LABEL = "aj-db-v1"
  private val thread = Executors.newSingleThreadExecutor { Thread(it, "aj-journal-db") }
  private var db: SQLiteDatabase? = null
  private var libraryLoaded = false

  fun file(context: Context) = File(context.noBackupFilesDir, "journal/journal.db")

  /** Runs on the database thread; rethrows the work's own exception. */
  fun <T> submit(work: () -> T): T =
      try {
        thread.submit(Callable { work() }).get()
      } catch (failure: ExecutionException) {
        throw failure.cause ?: failure
      }

  fun open(context: Context, vault: Vault) = submit {
    if (db?.isOpen == true) return@submit
    if (!libraryLoaded) {
      System.loadLibrary("sqlcipher")
      libraryLoaded = true
    }
    val key = vault.purposeKey(DB_KEY_LABEL)
    // SQLCipher raw-key syntax: x'<64 hex>' skips SQLCipher's own KDF.
    val password = "x'${key.joinToString("") { "%02x".format(it) }}'".toByteArray(Charsets.US_ASCII)
    try {
      val target = file(context).apply { parentFile?.mkdirs() }
      db = SQLiteDatabase.openOrCreateDatabase(target.path, password, null, null, null).apply {
        enableWriteAheadLogging()
        setForeignKeyConstraintsEnabled(true)
      }
    } finally {
      VaultCrypto.zero(key, password)
    }
  }

  fun close() = submit {
    db?.close()
    db = null
  }

  private fun requireOpen(): SQLiteDatabase =
      db?.takeIf { it.isOpen } ?: throw IllegalStateException("STORE_LOCKED")

  private fun args(json: String): Array<Any?> {
    val array = JSONArray(json)
    return Array(array.length()) { index ->
      when (val value = array.get(index)) {
        JSONObject.NULL -> null
        is Int -> value.toLong()
        is Long -> value
        is Double -> if (value % 1.0 == 0.0) value.toLong() else value
        is String -> value
        else -> throw IllegalArgumentException("unsupported SQL parameter")
      }
    }
  }

  fun run(sql: String, paramsJson: String): Int = submit {
    requireOpen().compileStatement(sql).use { statement ->
      args(paramsJson).forEachIndexed { index, value ->
        val position = index + 1
        when (value) {
          null -> statement.bindNull(position)
          is Long -> statement.bindLong(position, value)
          is Double -> statement.bindDouble(position, value)
          else -> statement.bindString(position, value as String)
        }
      }
      statement.executeUpdateDelete()
    }
  }

  fun all(sql: String, paramsJson: String): String = submit {
    // rawQuery takes Java varargs: the array must be spread, or Kotlin
    // passes it as one argument.
    requireOpen().rawQuery(sql, *args(paramsJson)).use { cursor -> rows(cursor).toString() }
  }

  private fun rows(cursor: Cursor): JSONArray {
    val out = JSONArray()
    while (cursor.moveToNext()) {
      val row = JSONObject()
      for (index in 0 until cursor.columnCount) {
        val name = cursor.getColumnName(index)
        when (cursor.getType(index)) {
          Cursor.FIELD_TYPE_NULL -> row.put(name, JSONObject.NULL)
          Cursor.FIELD_TYPE_INTEGER -> row.put(name, cursor.getLong(index))
          Cursor.FIELD_TYPE_FLOAT -> row.put(name, cursor.getDouble(index))
          Cursor.FIELD_TYPE_STRING -> row.put(name, cursor.getString(index))
          else -> throw IllegalStateException("blob columns are not used")
        }
      }
      out.put(row)
    }
    return out
  }

  /** Runs [block] with the open database on its own thread (backup only). */
  fun <T> withDatabase(block: (SQLiteDatabase) -> T): T = submit { block(requireOpen()) }

  fun begin() = submit { requireOpen().beginTransaction() }

  fun commit() = submit {
    val database = requireOpen()
    database.setTransactionSuccessful()
    database.endTransaction()
  }

  fun rollback() = submit { requireOpen().endTransaction() }

  /** Erase journal: close and delete the database and its WAL/SHM files. */
  fun deleteFiles(context: Context) = submit {
    db?.close()
    db = null
    val target = file(context)
    listOf("", "-wal", "-shm", "-journal").forEach { File(target.path + it).delete() }
  }
}
