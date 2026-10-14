package com.audiojournal.recording

import com.audiojournal.vault.VaultCrypto

/**
 * Reads PCM ranges from one AJR1 recording (playback, transcription). Frames
 * are located by header, then each frame in range is authenticated as it is
 * opened; the first frame that fails stops the read with
 * [javax.crypto.AEADBadTagException]. The per-file key lives only until
 * [close]. Plaintext is handed out one frame at a time.
 */
class Ajr1Reader(
    private val source: Ajr1.Source,
    recordingRootKey: ByteArray,
    private val recordingId: String,
) : AutoCloseable {
  private val headerBytes = source.read(0, Ajr1.HEADER_BYTES)
  private val header = Ajr1.Header.decode(headerBytes)
  private val headerHash = Ajr1.headerHash(headerBytes)
  private val frames = Ajr1.frames(source)
  // Derived last, so a structurally unreadable file never leaves a file key behind.
  private var key: ByteArray? = Ajr1.fileKey(recordingRootKey, header.salt, recordingId)

  /** PCM bytes in structurally complete frames (authenticated only when read). */
  val pcmBytes: Long = frames.lastOrNull()?.let { it.pcmOffset + it.length } ?: 0L

  /**
   * Delivers the PCM in `[startByte, endByte)` in order. [onPcm] gets a frame
   * buffer and the slice to use, and returns false to stop early. The buffer
   * is zeroed after the call.
   */
  fun read(
      startByte: Long,
      endByte: Long = pcmBytes,
      onPcm: (pcm: ByteArray, offset: Int, length: Int) -> Boolean,
  ) {
    require(startByte >= 0 && startByte % 2 == 0L && endByte >= startByte) { "AJR1_RANGE" }
    val end = minOf(endByte, pcmBytes)
    for (frame in frames) {
      val frameEnd = frame.pcmOffset + frame.length
      if (frameEnd <= startByte) continue
      if (frame.pcmOffset >= end) break
      val pcm = open(frame)
      try {
        val from = (maxOf(startByte, frame.pcmOffset) - frame.pcmOffset).toInt()
        val to = (minOf(end, frameEnd) - frame.pcmOffset).toInt()
        if (!onPcm(pcm, from, to - from)) return
      } finally {
        VaultCrypto.zero(pcm)
      }
    }
  }

  private fun open(frame: Ajr1.FrameRef): ByteArray {
    val current = key ?: throw IllegalStateException("AJR1_CLOSED")
    val sealed = source.read(frame.offset + Ajr1.FRAME_HEADER_BYTES, frame.length + Ajr1.TAG_BYTES)
    return VaultCrypto.open(
        current,
        Ajr1.nonce(header.noncePrefix, frame.index),
        Ajr1.aad(headerHash, recordingId, frame.index, frame.length),
        sealed)
  }

  /** Zeroes the key and closes a closeable source. */
  override fun close() {
    VaultCrypto.zero(key)
    key = null
    (source as? java.io.Closeable)?.close()
  }
}
