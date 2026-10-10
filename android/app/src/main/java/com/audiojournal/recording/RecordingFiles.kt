package com.audiojournal.recording

import com.audiojournal.vault.VaultCrypto
import java.io.File
import java.io.RandomAccessFile
import org.json.JSONArray
import org.json.JSONObject

/**
 * The recording root in no-backup storage (ADR-017, LLD §9). File operations
 * here never delete audio during reconciliation: unknown files are moved to a
 * quarantine directory, and only an unauthenticated torn tail is truncated.
 */
class RecordingFiles(noBackupDir: File) {
  val recordings = File(noBackupDir, "recordings")
  val quarantine = File(noBackupDir, "recordings-quarantine")

  fun fileFor(recordingId: String): File {
    require(ID.matches(recordingId)) { "AJR1_RECORDING_ID" }
    return File(recordings, "$recordingId.ajr")
  }

  /**
   * Lists the recording root (`src/features/journal/domain/reconciliation.ts`
   * `RecordingFileScan`). Recordings named in [authenticate] (unfinished
   * captures) are authenticated frame by frame; every other file is checked
   * by header and size only, so the cost of each unlock does not grow with
   * the archive.
   */
  fun scan(authenticate: Set<String>, recordingRootKey: () -> ByteArray): JSONArray {
    val out = JSONArray()
    val names = recordings.list()?.sorted() ?: emptyList()
    for (name in names) {
      val file = File(recordings, name)
      if (!file.isFile) continue
      val id = name.removeSuffix(".ajr").takeIf { name.endsWith(".ajr") && ID.matches(it) }
      out.put(
          if (id != null && id in authenticate) authenticated(file, id, recordingRootKey)
          else headerOnly(file))
    }
    return out
  }

  private fun relative(file: File) = "recordings/${file.name}"

  private fun headerOnly(file: File): JSONObject {
    val valid =
        try {
          RandomAccessFile(file, "r").use { raf ->
            raf.length() >= Ajr1.HEADER_BYTES &&
                run {
                  Ajr1.Header.decode(Ajr1.FileSource(raf).read(0, Ajr1.HEADER_BYTES))
                  true
                }
          }
        } catch (_: Exception) {
          false
        }
    return JSONObject()
        .put("relativePath", relative(file))
        .put("check", "header")
        .put("headerValid", valid)
        .put("fileBytes", file.length())
  }

  private fun authenticated(file: File, id: String, recordingRootKey: () -> ByteArray): JSONObject {
    val json =
        JSONObject()
            .put("relativePath", relative(file))
            .put("check", "authenticated")
            .put("fileBytes", file.length())
    val scan =
        try {
          RandomAccessFile(file, "r").use { raf ->
            val key = recordingRootKey()
            try {
              Ajr1.scan(Ajr1.FileSource(raf), key, id)
            } finally {
              VaultCrypto.zero(key)
            }
          }
        } catch (failure: IllegalArgumentException) {
          // Header missing or invalid: nothing authenticates.
          return json
              .put("headerValid", false)
              .put("authenticatedChunks", 0)
              .put("authenticatedMs", 0)
              .put("trailingBytes", file.length())
              .put("tail", "damaged")
              .put("byteCount", 0)
        }
    json
        .put("headerValid", true)
        .put("authenticatedChunks", scan.frames)
        .put("authenticatedMs", scan.pcmBytes / CaptureSession.PCM_BYTES_PER_MS)
        .put("trailingBytes", scan.trailingBytes)
        .put("tail", tail(scan))
        .put("byteCount", scan.validEnd)
    // The digest covers the authenticated frames, which is what remains once
    // a torn final frame is dropped; a damaged file is never promoted.
    if (scan.stop == null || scan.stop == "TORN") {
      json.put("contentSha256", CaptureSession.hex(scan.sha256))
    }
    return json
  }

  /** A torn final frame is a write cut short; any other stop is damage. */
  private fun tail(scan: Ajr1.Scan) =
      when (scan.stop) {
        null -> "none"
        "TORN" -> "torn"
        else -> "damaged"
      }

  /**
   * Truncates an unfinished capture to its authenticated frames, only when
   * the remainder is a torn final frame and the frame count still matches the
   * plan. Damage elsewhere (an authentication or ordering failure) is left in
   * place: frames after it may still be authentic. A recovered file is never
   * appended to again, so a truncated index is never reused (ADR-017).
   */
  fun dropTornTail(recordingId: String, sealedChunks: Int, recordingRootKey: ByteArray): Boolean {
    val file = fileFor(recordingId)
    if (!file.isFile) return false
    return RandomAccessFile(file, "rw").use { raf ->
      val scan = Ajr1.scan(Ajr1.FileSource(raf), recordingRootKey, recordingId)
      if (scan.stop != "TORN" || scan.frames != sealedChunks) return@use false
      raf.setLength(scan.validEnd)
      raf.fd.sync()
      true
    }
  }

  /** Moves an unknown file aside; it is never deleted automatically. */
  fun quarantine(relativePath: String, now: Long): Boolean {
    val name = relativePath.removePrefix("recordings/")
    require(
        relativePath.startsWith("recordings/") &&
            name.isNotEmpty() &&
            !name.contains('/') &&
            name != "." &&
            name != "..") {
          "QUARANTINE_PATH"
        }
    val file = File(recordings, name)
    if (!file.isFile) return false
    quarantine.mkdirs()
    return file.renameTo(File(quarantine, "$now-$name"))
  }

  /** Erase journal (ADR-017): plain deletion, not cryptographic erasure. */
  fun eraseAll() {
    recordings.deleteRecursively()
    quarantine.deleteRecursively()
  }

  fun freeBytes(): Long = recordings.parentFile?.usableSpace ?: 0L

  companion object {
    /** Same rule as `isLocalId(id, 'rec')` in src/features/journal/domain/ids.ts. */
    val ID = Regex("^rec_[0-9a-hjkmnp-tv-z]{26}$")
  }
}
