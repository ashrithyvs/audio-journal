package com.audiojournal.speech

import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Reads 16 kHz mono 16-bit PCM WAV into normalized floats, rejecting anything else. */
object Wav {
  class Invalid(reason: String) : IllegalArgumentException(reason)

  fun read16kMono(file: File): FloatArray {
    val bytes = file.readBytes()
    if (bytes.size < 44) throw Invalid("short")
    val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
    fun tag(at: Int) = String(bytes, at, 4, Charsets.US_ASCII)
    if (tag(0) != "RIFF" || tag(8) != "WAVE") throw Invalid("not RIFF/WAVE")
    var at = 12
    var format = -1
    var channels = -1
    var rate = -1
    var bits = -1
    while (at + 8 <= bytes.size) {
      val id = tag(at)
      val size = buffer.getInt(at + 4)
      val body = at + 8
      if (id == "fmt ") {
        format = buffer.getShort(body).toInt()
        channels = buffer.getShort(body + 2).toInt()
        rate = buffer.getInt(body + 4)
        bits = buffer.getShort(body + 14).toInt()
      } else if (id == "data") {
        if (format != 1 || channels != 1 || rate != 16_000 || bits != 16) {
          throw Invalid("requires 16 kHz mono 16-bit PCM")
        }
        val count = minOf(size, bytes.size - body) / 2
        return FloatArray(count) { index -> buffer.getShort(body + index * 2) / 32768f }
      }
      at = body + size + (size and 1)
    }
    throw Invalid("no data chunk")
  }
}
