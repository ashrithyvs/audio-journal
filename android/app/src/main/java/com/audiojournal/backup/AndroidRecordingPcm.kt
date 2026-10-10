package com.audiojournal.backup

import com.audiojournal.recording.Ajr1
import com.audiojournal.recording.Ajr1Reader
import com.audiojournal.recording.RecordingFiles
import com.audiojournal.vault.VaultCrypto
import java.io.RandomAccessFile

/** Recording PCM for export, decrypted natively from AJR1 (ADR-017). */
class AndroidRecordingPcm(
    private val files: RecordingFiles,
    private val recordingRootKey: () -> ByteArray,
) : RecordingPcm {
  /** Frame lengths from headers only; pass 2 authenticates every frame. */
  override fun pcmBytes(recordingId: String): Long =
      RandomAccessFile(files.fileFor(recordingId), "r").use { raf ->
        val source = Ajr1.FileSource(raf)
        Ajr1.Header.decode(source.read(0, Ajr1.HEADER_BYTES))
        Ajr1.frames(source).lastOrNull()?.let { it.pcmOffset + it.length } ?: 0L
      }

  /** A recoverable recording travels as its authenticated prefix. */
  override fun authenticatedPrefix(recordingId: String): Pair<Long, String> =
      RandomAccessFile(files.fileFor(recordingId), "r").use { raf ->
        val key = recordingRootKey()
        try {
          val scan = Ajr1.scan(Ajr1.FileSource(raf), key, recordingId)
          scan.pcmBytes to Ajb1.hex(scan.sha256)
        } finally {
          VaultCrypto.zero(key)
        }
      }

  override fun stream(recordingId: String, pcmBytes: Long, onPcm: (ByteArray, Int, Int) -> Unit) {
    val key = recordingRootKey()
    val file = RandomAccessFile(files.fileFor(recordingId), "r")
    val reader =
        try {
          Ajr1Reader(Ajr1.FileSource(file), key, recordingId)
        } catch (failure: Throwable) {
          file.close() // the reader owns the file only once it exists
          throw failure
        } finally {
          VaultCrypto.zero(key)
        }
    reader.use {
      it.read(0, pcmBytes) { pcm, offset, length ->
        onPcm(pcm, offset, length)
        true
      }
    }
  }
}
