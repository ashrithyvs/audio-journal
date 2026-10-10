package com.audiojournal.backup

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import com.audiojournal.recording.ActiveAudio
import com.audiojournal.recording.RecordingFiles
import com.audiojournal.specs.NativeAudioJournalBackupSpec
import com.audiojournal.speech.RecordingJobs
import com.audiojournal.store.JournalDatabase
import com.audiojournal.vault.Argon2idKdf
import com.audiojournal.vault.KdfParams
import com.audiojournal.vault.KeystoreBiometricKeys
import com.audiojournal.vault.PinResult
import com.audiojournal.vault.VaultCrypto
import com.audiojournal.vault.VaultHolder
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONArray
import org.json.JSONObject

/**
 * TurboModule over AJB1 export and restore (ADR-017, backup-and-restore.md
 * §9.10, owner decisions of 2026-10-10). Journal content, PCM, secrets, and
 * keys stay native. Results carry counts, sizes, typed codes, and for damaged
 * entries their local labels only. Nothing is logged.
 */
class AudioJournalBackupModule(private val context: ReactApplicationContext) :
    NativeAudioJournalBackupSpec(context), ActivityEventListener {

  private val executor = Executors.newSingleThreadExecutor()
  private val vault by lazy { VaultHolder.get(context) }
  private val files by lazy { RecordingFiles(context.noBackupFilesDir) }
  private val wordlist by lazy {
    BackupSecrets.Wordlist(context.assets.open("bip39-english.txt").use { it.readBytes() })
  }
  private val kdf = ArchiveKdf { secret, salt, params -> Argon2idKdf().derive(secret, salt, params) }
  private val cancelled = AtomicBoolean(false)

  // Export state: a verified archive in app-private cache, and its KEK.
  private var part: File? = null
  private var partKek: ByteArray? = null
  // Restore state.
  private var archive: Uri? = null
  private var archiveSize = 0L
  private var archiveKind = 0
  private var opened: BackupRestorer.Opened? = null
  private var staging: StagingVault? = null
  // One pending picker at a time.
  private var picker: ((Uri?) -> Unit)? = null

  init {
    context.addActivityEventListener(this)
    executor.execute { cleanupStaleParts() }
    current = java.lang.ref.WeakReference(this)
  }

  /** Lock or erase: nothing prepared or staged outlives the unlocked session. */
  private fun discardAll() {
    // A running operation stops at its next checkpoint; locking never waits long.
    cancelled.set(true)
    runCatching {
      executor
          .submit {
            discardPart()
            abandon()
          }
          .get(30, java.util.concurrent.TimeUnit.SECONDS)
    }
  }

  override fun getName() = NAME

  private class Cancelled : Exception("CANCELLED")

  private fun checkpoint(operation: String): (String) -> Unit = { phase ->
    if (cancelled.get()) throw Cancelled()
    emitOnBackupProgress(
        Arguments.createMap().apply {
          putString("operation", operation)
          putString("phase", phase)
        })
  }

  private fun json(vararg pairs: Pair<String, Any?>) =
      JSONObject().apply { pairs.forEach { (k, v) -> put(k, v ?: JSONObject.NULL) } }.toString()

  private fun failed(error: Throwable): String =
      when (error) {
        is Cancelled -> json("status" to "cancelled")
        is Ajb1.Failure -> json("status" to "failed", "code" to error.code, "stage" to error.stage)
        is CanonicalJson.Failure -> json("status" to "failed", "code" to "NON_CANONICAL_JSON")
        is IllegalStateException ->
            json(
                "status" to "failed",
                "code" to (error.message?.takeIf { it.matches(CODE) } ?: "BACKUP_FAILED"))
        else -> json("status" to "failed", "code" to "BACKUP_FAILED")
      }

  private fun settle(promise: Promise, work: () -> String) {
    executor.execute {
      cancelled.set(false)
      promise.resolve(
          try {
            work()
          } catch (error: Throwable) {
            failed(error)
          })
    }
  }

  private fun purposeKey(label: String) = vault.purposeKey(label)

  private fun snapshot() =
      purposeKey("aj-db-v1").let { key ->
        try {
          SqlJournalSnapshot.open(JournalDatabase.file(context), key)
        } finally {
          key.fill(0)
        }
      }

  private fun exporter(snapshot: SqlJournalSnapshot, operation: String) =
      BackupExporter(snapshot, AndroidRecordingPcm(files) { purposeKey("aj-rec-v1") }, checkpoint = checkpoint(operation))

  private fun damagedJson(snapshot: SqlJournalSnapshot, damaged: BackupExporter.Damaged): JSONArray {
    val labels = snapshot.labels(damaged.entries.map { it.first })
    return JSONArray().apply {
      for ((entryId, recordingId) in damaged.entries) {
        val (createdAt, title) = labels[entryId] ?: (0L to null)
        put(
            JSONObject()
                .put("entryId", entryId)
                .put("recordingId", recordingId)
                .put("createdAtMs", createdAt)
                .put("title", title ?: JSONObject.NULL)
                .put("component", "recording"))
      }
    }
  }

  // --- Export ---

  override fun estimateBackup(promise: Promise) = settle(promise) {
    snapshot().use { snapshot ->
      try {
        val plan = exporter(snapshot, "estimate").plan(System.currentTimeMillis())
        json(
            "status" to "ready",
            "entries" to plan.counts["entry"],
            "recordings" to plan.counts["recording"],
            "segments" to plan.counts["transcriptSegment"],
            "pcmBytes" to plan.pcmBytes,
            "archiveBytes" to plan.archiveBytes,
            "freeBytes" to context.cacheDir.usableSpace)
      } catch (damaged: BackupExporter.Damaged) {
        JSONObject().put("status", "damaged").put("entries", damagedJson(snapshot, damaged)).toString()
      }
    }
  }

  override fun generateRecoveryKey(promise: Promise) {
    executor.execute {
      val entropy = VaultCrypto.randomBytes(BackupSecrets.RECOVERY_KEY_BYTES)
      try {
        promise.resolve(wordlist.encode(entropy))
      } finally {
        entropy.fill(0)
      }
    }
  }

  private fun secretBytes(kind: Int, secret: String): ByteArray =
      when (val decoded =
          if (kind == Ajb1.SECRET_PASSWORD) BackupSecrets.password(secret) else wordlist.decode(secret)) {
        is BackupSecrets.Decoded.Ok -> decoded.bytes
        is BackupSecrets.Decoded.Rejected -> throw Ajb1.Failure(decoded.reason, "secret")
      }

  private fun kindOf(name: String) =
      when (name) {
        "password" -> Ajb1.SECRET_PASSWORD
        "recoveryKey" -> Ajb1.SECRET_RECOVERY_KEY
        else -> throw Ajb1.Failure("SECRET_KIND", "secret")
      }

  override fun prepareBackup(secretKind: String, secret: String, excludeJson: String, promise: Promise) =
      settle(promise) {
        discardPart()
        val kind = kindOf(secretKind)
        val exclude = JSONArray(excludeJson).let { list -> (0 until list.length()).map { list.getString(it) }.toSet() }
        snapshot().use { snapshot ->
          val exporter = exporter(snapshot, "export")
          val plan =
              try {
                exporter.plan(System.currentTimeMillis(), exclude)
              } catch (damaged: BackupExporter.Damaged) {
                return@settle JSONObject()
                    .put("status", "damaged")
                    .put("entries", damagedJson(snapshot, damaged))
                    .toString()
              }
          // Free space before any KDF work (§9.8).
          if (context.cacheDir.usableSpace < plan.archiveBytes + Ajb1.Limits.V1.exportReserveBytes) {
            throw Ajb1.Failure("INSUFFICIENT_STORAGE", "export")
          }
          val secretBytes = secretBytes(kind, secret)
          // PROVISIONAL KDF parameters (§9.8): the policy floor until the
          // physical-device benchmark freezes production values.
          val params: KdfParams = Ajb1.KdfPolicy.PROVISIONAL.floor
          val salt = VaultCrypto.randomBytes(16)
          val kek =
              try {
                kdf.derive(secretBytes, salt, params)
              } finally {
                secretBytes.fill(0)
              }
          checkpoint("export")("kdf")
          val target = File(context.cacheDir, "ajb1-${Ajb1.hex(VaultCrypto.randomBytes(16))}.part")
          try {
            // The writer draws its own randoms; the salt must be the one the
            // KEK came from, so it is fed first.
            var saltUsed = false
            val random = { size: Int ->
              if (size == 16 && !saltUsed) salt.also { saltUsed = true } else VaultCrypto.randomBytes(size)
            }
            FileOutputStream(target).buffered(1 shl 20).use { out ->
              exporter.write(plan, out, params, kind, kek, random)
            }
            checkpoint("export")("written")
            verifyArchive(fileSource(target), kind, kek)
            checkpoint("export")("verified")
            part = target
            partKek = kek
            json(
                "status" to "ready",
                "bytes" to target.length(),
                "excluded" to exclude.size,
                "entries" to plan.counts["entry"],
                "recordings" to plan.counts["recording"])
          } catch (error: Throwable) {
            target.delete()
            kek.fill(0)
            throw error
          }
        }
      }

  private fun fileSource(file: File) =
      object : ArchiveSource {
        override val size = file.length()

        override fun open(): InputStream = FileInputStream(file).buffered(1 shl 20)
      }

  /** Full verification: every segment, section, record, and digest. */
  private fun verifyArchive(source: ArchiveSource, kind: Int, kek: ByteArray) {
    val restorer = BackupRestorer({ _, _, _ -> kek.copyOf() })
    restorer.open(source, kind, ByteArray(0), Long.MAX_VALUE).use { opened ->
      restorer.stage(source, opened, object : ArchiveSink {})
    }
  }

  override fun saveBackup(suggestedName: String, promise: Promise) {
    val source = part
    if (source == null) {
      promise.resolve(json("status" to "failed", "code" to "NOTHING_PREPARED"))
      return
    }
    val intent =
        Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("application/octet-stream")
            .putExtra(Intent.EXTRA_TITLE, suggestedName)
    launchPicker(intent, promise) { uri ->
      executor.execute { promise.resolve(copyToDestination(source, uri)) }
    }
  }

  /** Copies, then verifies the destination byte for byte against the verified file. */
  private fun copyToDestination(source: File, uri: Uri): String {
    val resolver = context.contentResolver
    return try {
      val expected = MessageDigest.getInstance("SHA-256")
      resolver.openOutputStream(uri, "wt")!!.use { out ->
        FileInputStream(source).use { input ->
          val buffer = ByteArray(1 shl 20)
          while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            expected.update(buffer, 0, count)
            out.write(buffer, 0, count)
          }
        }
      }
      val actual = MessageDigest.getInstance("SHA-256")
      var bytes = 0L
      resolver.openInputStream(uri)!!.use { input ->
        val buffer = ByteArray(1 shl 20)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          actual.update(buffer, 0, count)
          bytes += count
        }
      }
      if (bytes != source.length() || !actual.digest().contentEquals(expected.digest())) {
        throw IllegalStateException("DESTINATION_MISMATCH")
      }
      discardPart()
      json("status" to "complete", "bytes" to bytes, "name" to displayName(uri))
    } catch (error: Throwable) {
      // Best effort: remove the destination this export created.
      val removed = runCatching { DocumentsContract.deleteDocument(resolver, uri) }.getOrDefault(false)
      JSONObject(failed(error)).put("destinationRemoved", removed).toString()
    }
  }

  override fun cancelBackup() {
    cancelled.set(true)
  }

  override fun discardBackup(promise: Promise) {
    executor.execute {
      discardPart()
      promise.resolve(null)
    }
  }

  private fun discardPart() {
    part?.delete()
    part = null
    VaultCrypto.zero(partKek)
    partKek = null
  }

  /** After process death, leftover temporary archives are unreadable ciphertext. */
  private fun cleanupStaleParts() {
    context.cacheDir.listFiles()?.filter { Regex("^ajb1-[0-9a-f]{32}\\.part$").matches(it.name) }?.forEach {
      it.delete()
    }
  }

  // --- Restore ---

  private fun count(sql: String): Long =
      JournalDatabase.withDatabase { db -> db.rawQuery(sql, emptyArray<String>()).use { if (it.moveToFirst()) it.getLong(0) else 0L } }

  private fun targetCounts(): JSONObject {
    val playable =
        count("SELECT count(*) FROM recordings WHERE state IN ('ready', 'recoverable')")
    val known =
        JournalDatabase.withDatabase { db ->
          db.rawQuery(
                  "SELECT relative_path FROM recordings WHERE state IN ('ready', 'recoverable')",
                  emptyArray<String>())
              .use { cursor -> buildSet { while (cursor.moveToNext()) add(cursor.getString(0)) } }
        }
    val leftover =
        (files.recordings.listFiles()?.count { "recordings/${it.name}" !in known } ?: 0) +
            (files.quarantine.listFiles()?.size ?: 0)
    return JSONObject()
        .put("readyEntries", count("SELECT count(*) FROM journal_entries WHERE status = 'ready'"))
        .put(
            "needsAttentionEntries",
            count("SELECT count(*) FROM journal_entries WHERE status = 'recovery_required'"))
        .put("playableRecordings", playable)
        .put(
            "hiddenRows",
            count("SELECT count(*) FROM journal_entries WHERE status NOT IN ('ready', 'recovery_required')") +
                count("SELECT count(*) FROM recordings WHERE state NOT IN ('ready', 'recoverable')"))
        .put("leftoverFiles", leftover)
  }

  private fun journalIsEmpty(counts: JSONObject) =
      counts.getLong("readyEntries") == 0L &&
          counts.getLong("needsAttentionEntries") == 0L &&
          counts.getLong("playableRecordings") == 0L

  override fun restoreTarget(promise: Promise) = settle(promise) { targetCounts().toString() }

  private fun uriSource(uri: Uri, size: Long) =
      object : ArchiveSource {
        override val size = size

        override fun open(): InputStream =
            (context.contentResolver.openInputStream(uri) ?: throw Ajb1.Failure("NOT_READABLE", "header"))
                .buffered(1 shl 20)
      }

  override fun pickArchive(promise: Promise) {
    val intent =
        Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
    launchPicker(intent, promise) { uri ->
      executor.execute {
        promise.resolve(
            try {
              val size = sizeOf(uri)
              val header =
                  uriSource(uri, size).open().use { input ->
                    ByteArray(minOf(size, Ajb1.HEADER_BYTES.toLong()).toInt()).also {
                      var at = 0
                      while (at < it.size) {
                        val n = input.read(it, at, it.size - at)
                        if (n < 0) break
                        at += n
                      }
                    }
                  }
              val info =
                  Ajb1.precheck(header, size, restoreAvailableBytes = context.noBackupFilesDir.usableSpace)
              abandon()
              archive = uri
              archiveSize = size
              archiveKind = info.secretKind
              json(
                  "status" to "picked",
                  "bytes" to size,
                  "secretKind" to if (info.secretKind == Ajb1.SECRET_PASSWORD) "password" else "recoveryKey",
                  "name" to displayName(uri))
            } catch (error: Throwable) {
              failed(error)
            })
      }
    }
  }

  override fun openArchive(secret: String, promise: Promise) = settle(promise) {
    val uri = archive ?: throw IllegalStateException("NOTHING_PICKED")
    opened?.close()
    opened = null
    val bytes = secretBytes(archiveKind, secret)
    val result =
        try {
          BackupRestorer(kdf)
              .open(
                  uriSource(uri, archiveSize),
                  archiveKind,
                  bytes,
                  context.noBackupFilesDir.usableSpace,
                  checkpoint("restore"))
        } finally {
          bytes.fill(0)
        }
    opened = result
    val records = result.manifest["records"] as Map<*, *>
    val counts = records["counts"] as Map<*, *>
    json(
        "status" to "opened",
        "createdAtMs" to result.manifest["createdAtMs"],
        "entries" to counts["entry"],
        "recordings" to counts["recording"],
        "segments" to counts["transcriptSegment"],
        "pcmBytes" to (result.manifest["pcm"] as Map<*, *>)["bytes"],
        "requiredBytes" to archiveSize + Ajb1.Limits.V1.restoreReserveBytes)
  }

  override fun stageRestore(promise: Promise) = settle(promise) {
    val uri = archive ?: throw IllegalStateException("NOTHING_PICKED")
    val current = opened ?: throw IllegalStateException("NOT_OPENED")
    if (!journalIsEmpty(targetCounts())) throw IllegalStateException("JOURNAL_NOT_EMPTY")
    staging?.let {
      it.close()
      it.delete()
    }
    val schema = JournalDatabase.withDatabase { StagingVault.schemaOf(it) }
    val vaultDir = RestoreActivation.restoreDir(context.noBackupFilesDir).apply { mkdirs() }
    val next = StagingVault(vaultDir, schema)
    try {
      BackupRestorer(kdf).stage(uriSource(uri, archiveSize), current, next, checkpoint("restore"))
      next.commit()
    } catch (error: Throwable) {
      next.close()
      next.delete()
      throw error
    }
    staging = next
    json("status" to "staged")
  }

  override fun activateRestore(pin: String, promise: Promise) = settle(promise) {
    val staged = staging ?: throw IllegalStateException("NOT_STAGED")
    // The rule again, just before anything changes (owner decision 2026-10-10).
    if (!journalIsEmpty(targetCounts())) throw IllegalStateException("JOURNAL_NOT_EMPTY")
    val pinBytes = pin.toByteArray(Charsets.UTF_8)
    val key = staged.masterKey()
    val (result, record) =
        try {
          vault.adoptionRecord(pinBytes, key)
        } finally {
          VaultCrypto.zero(pinBytes, key)
        }
    when (result) {
      is PinResult.WrongPin -> return@settle json("result" to "wrong_pin", "retryAt" to result.retryAt)
      is PinResult.Refused -> return@settle json("result" to "refused", "retryAt" to result.retryAt)
      PinResult.Unavailable -> return@settle json("result" to "unavailable")
      PinResult.Unlocked -> Unit
    }
    val root = context.noBackupFilesDir
    runCatching { ActiveAudio.closeAll() }
    runCatching { RecordingJobs.cancelAll() }
    JournalDatabase.close()
    RestoreActivation.begin(root, staged.name, record!!)
    try {
      RestoreActivation.complete(root)
    } catch (error: Throwable) {
      // Before the vault switch this restores the old journal exactly;
      // after it, the next start completes the activation.
      runCatching { RestoreActivation.undo(root) }
      throw error
    } finally {
      staged.close()
      staging = null
      opened?.close()
      opened = null
      archive = null
    }
    // Biometric unlock is re-enabled by the user later; the app locks now.
    runCatching { KeystoreBiometricKeys(context).delete() }
    vault.lock()
    json("result" to "activated")
  }

  override fun abandonRestore(promise: Promise) {
    executor.execute {
      abandon()
      promise.resolve(null)
    }
  }

  private fun abandon() {
    staging?.let {
      it.close()
      it.delete()
    }
    staging = null
    opened?.close()
    opened = null
    archive = null
  }

  // --- Pickers ---

  private fun launchPicker(intent: Intent, promise: Promise, onPicked: (Uri) -> Unit) {
    val activity = context.currentActivity
    if (activity == null || picker != null) {
      promise.resolve(json("status" to "failed", "code" to "PICKER_UNAVAILABLE"))
      return
    }
    picker = { uri ->
      if (uri == null) promise.resolve(json("status" to "cancelled")) else onPicked(uri)
    }
    activity.startActivityForResult(intent, PICKER_REQUEST)
  }

  override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode != PICKER_REQUEST) return
    val callback = picker ?: return
    picker = null
    callback(if (resultCode == Activity.RESULT_OK) data?.data else null)
  }

  override fun onNewIntent(intent: Intent) = Unit

  private fun sizeOf(uri: Uri): Long =
      context.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use {
        if (it.moveToFirst() && !it.isNull(0)) it.getLong(0) else null
      } ?: throw Ajb1.Failure("NOT_READABLE", "header")

  private fun displayName(uri: Uri): String? =
      runCatching {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
              if (it.moveToFirst()) it.getString(0) else null
            }
          }
          .getOrNull()

  override fun invalidate() {
    context.removeActivityEventListener(this)
    executor.execute {
      discardPart()
      abandon()
    }
    super.invalidate()
  }

  companion object {
    const val NAME = "AudioJournalBackup"
    private const val PICKER_REQUEST = 4_217
    @Volatile private var current: java.lang.ref.WeakReference<AudioJournalBackupModule>? = null

    /** Called by the vault on lock and erase. */
    fun onLock() {
      current?.get()?.discardAll()
    }
    private val CODE = Regex("^[A-Z][A-Z0-9_]{2,40}$")
  }
}
