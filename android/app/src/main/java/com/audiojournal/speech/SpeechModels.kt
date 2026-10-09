package com.audiojournal.speech

import android.content.Context
import java.io.File
import java.security.MessageDigest

/**
 * Pinned on-device transcription models (ADR-016). They ship as APK assets,
 * are copied once to no-backup storage, and are SHA-256-verified before the
 * first load in each process.
 */
object SpeechModels {
  const val DEFAULT = "base.en-q5_1"
  val pinned =
      linkedMapOf(
          "base.en-q5_1" to "4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f",
          "tiny.en-q5_1" to "c77c5766f1cef09b6b7d47f21b546cbddd4157886b3b5d6d4f709e91e66c7c2b",
      )
  private val verified = mutableSetOf<String>()

  private fun asset(id: String) = "speech-models/ggml-$id.bin"

  fun bundled(context: Context, id: String): Boolean =
      try {
        context.assets.open(asset(id)).close()
        true
      } catch (_: Exception) {
        false
      }

  @Synchronized
  fun file(context: Context, id: String): File {
    val expected = pinned[id] ?: throw IllegalArgumentException("unknown model")
    val directory = File(context.noBackupFilesDir, "speech-models").apply { mkdirs() }
    val target = File(directory, "ggml-$id.bin")
    if (id in verified && target.isFile) return target
    if (!target.isFile || sha256(target) != expected) {
      val temp = File(directory, "ggml-$id.bin.tmp")
      context.assets.open(asset(id)).use { input -> temp.outputStream().use { input.copyTo(it) } }
      if (sha256(temp) != expected) {
        temp.delete()
        throw SecurityException("model checksum mismatch")
      }
      if (!temp.renameTo(target)) throw IllegalStateException("rename failed")
    }
    verified += id
    return target
  }

  private fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buffer = ByteArray(1 shl 20)
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        digest.update(buffer, 0, read)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }
}
