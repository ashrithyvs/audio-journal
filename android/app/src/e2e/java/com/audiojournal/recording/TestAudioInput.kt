package com.audiojournal.recording

import android.content.Context
import android.os.SystemClock
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * `e2e` builds only (the AJ-2 voice-entry device journey). The next capture
 * reads 16 kHz mono 16-bit PCM from a WAV that the device suite pushes to
 * `<external files>/test-audio/input.wav`. It plays at real-time pace, then
 * continues with silence until the user stops. One capture consumes the
 * file.
 *
 * Release and debug builds compile a stub that returns null, so they always
 * use the microphone. Everything after the source is the production path:
 * AJR1 sealing, the on-device final pass, and organization.
 */
object TestAudioInput {
  fun sourceOrNull(context: Context): PcmSource? {
    val dir = File(context.getExternalFilesDir(null), "test-audio").apply { mkdirs() }
    val file = File(dir, "input.wav")
    if (!file.isFile) return null
    val pcm = pcm16Mono16k(file.readBytes()) ?: return null
    file.delete()
    return FilePcmSource(pcm)
  }

  /** The `data` chunk of a 16 kHz, mono, 16-bit PCM WAV, or null. */
  private fun pcm16Mono16k(bytes: ByteArray): ByteArray? {
    if (bytes.size < 12) return null
    if (String(bytes, 0, 4, Charsets.US_ASCII) != "RIFF") return null
    if (String(bytes, 8, 4, Charsets.US_ASCII) != "WAVE") return null
    val le = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
    var at = 12
    var format = false
    while (at + 8 <= bytes.size) {
      val name = String(bytes, at, 4, Charsets.US_ASCII)
      val size = le.getInt(at + 4)
      val body = at + 8
      when (name) {
        "fmt " -> {
          format =
              le.getShort(body).toInt() == 1 &&
                  le.getShort(body + 2).toInt() == 1 &&
                  le.getInt(body + 4) == Ajr1.SAMPLE_RATE &&
                  le.getShort(body + 14).toInt() == 16
          if (!format) return null
        }
        "data" -> return if (format) bytes.copyOfRange(body, minOf(body + size, bytes.size)) else null
      }
      at = body + size + (size and 1)
    }
    return null
  }
}

/** PCM at real-time pace (32 bytes per millisecond), then silence. */
private class FilePcmSource(private val pcm: ByteArray) : PcmSource {
  private var delivered = 0L
  private var epochAt = 0L
  private var epochDelivered = 0L

  override fun start() {
    epochAt = SystemClock.elapsedRealtime()
    epochDelivered = delivered
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    val due = (SystemClock.elapsedRealtime() - epochAt) * 32 - (delivered - epochDelivered)
    if (due < 2) {
      Thread.sleep(20)
      return 0
    }
    val n = (minOf(length.toLong(), due).toInt()) and 1.inv()
    for (i in 0 until n) {
      val at = delivered + i
      buffer[offset + i] = if (at < pcm.size) pcm[at.toInt()] else 0
    }
    delivered += n
    return n
  }

  override fun stop() {}

  override fun release() {}
}
