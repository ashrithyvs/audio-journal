package com.audiojournal.store

import android.database.SQLException
import com.audiojournal.specs.NativeAudioJournalStoreSpec
import com.audiojournal.vault.VaultCrypto
import com.audiojournal.vault.VaultHolder
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import java.util.concurrent.Executors

/**
 * TurboModule over [JournalDatabase] (ADR-017). SQL arrives with bound
 * parameters only; errors carry a code and the failing constraint or trigger
 * text, never SQL values. Nothing is logged.
 */
class AudioJournalStoreModule(private val context: ReactApplicationContext) :
    NativeAudioJournalStoreSpec(context) {

  // Keeps the JS thread free; JournalDatabase serializes onto its own thread.
  private val executor = Executors.newSingleThreadExecutor()

  override fun getName() = NAME

  private fun settle(promise: Promise, work: () -> Any?) {
    executor.execute {
      try {
        promise.resolve(work())
      } catch (failure: Throwable) {
        val (code, message) = classify(failure)
        promise.reject(code, message)
      }
    }
  }

  override fun open(promise: Promise) = settle(promise) {
    JournalDatabase.open(context, VaultHolder.get(context))
    null
  }

  override fun close(promise: Promise) = settle(promise) {
    JournalDatabase.close()
    null
  }

  override fun run(sql: String, paramsJson: String, promise: Promise) = settle(promise) {
    JournalDatabase.run(sql, paramsJson).toDouble()
  }

  override fun all(sql: String, paramsJson: String, promise: Promise) = settle(promise) {
    JournalDatabase.all(sql, paramsJson)
  }

  override fun begin(promise: Promise) = settle(promise) {
    JournalDatabase.begin()
    null
  }

  override fun commit(promise: Promise) = settle(promise) {
    JournalDatabase.commit()
    null
  }

  override fun rollback(promise: Promise) = settle(promise) {
    JournalDatabase.rollback()
    null
  }

  override fun randomBytesHex(count: Double): String {
    require(count in 1.0..64.0) { "count" }
    return VaultCrypto.randomBytes(count.toInt()).joinToString("") { "%02x".format(it) }
  }

  override fun sha256Hex(text: String): String = OrganizeDigests.sha256Hex(text)

  override fun hmacSha256Hex(keyHex: String, label: String, text: String): String =
      OrganizeDigests.hmacSha256Hex(keyHex, label, text)

  companion object {
    const val NAME = "AudioJournalStore"

    /** Keeps the SQLite reason (constraint or trigger name), drops the SQL. */
    fun classify(failure: Throwable): Pair<String, String> =
        when {
          failure is IllegalStateException && failure.message == "STORE_LOCKED" ->
              "STORE_LOCKED" to "STORE_LOCKED"
          failure is SQLException || failure.javaClass.name.contains("SQLite") -> {
            val reason =
                (failure.message ?: "")
                    .substringBefore(" (code")
                    .substringBefore(", while compiling")
                    .take(200)
            (if (failure.javaClass.simpleName.contains("Constraint")) "SQL_CONSTRAINT"
            else "SQL_ERROR") to reason
          }
          else -> "STORE_FAILED" to failure.javaClass.simpleName
        }
  }
}
