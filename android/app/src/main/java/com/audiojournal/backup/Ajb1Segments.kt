package com.audiojournal.backup

import com.audiojournal.vault.VaultCrypto
import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream
import javax.crypto.AEADBadTagException

/**
 * Seals a plaintext stream into AJB1 segments (§9.3): full segments of
 * exactly L bytes, then one final segment of 0..L-1 bytes. Holds at most one
 * segment of plaintext, zeroed after sealing.
 */
class SegmentWriter(
    private val out: OutputStream,
    header: ByteArray,
    private val dek: ByteArray,
    private val noncePrefix: ByteArray,
) {
  private val headerHash = Ajb1.sha256(header)
  private val buffer = ByteArray(Ajb1.SEGMENT_BYTES)
  private var filled = 0
  private var index = 0L
  private var finished = false

  /** Plaintext written so far. */
  var plaintextBytes = 0L
    private set

  init {
    out.write(header)
  }

  fun write(bytes: ByteArray, offset: Int = 0, length: Int = bytes.size) {
    check(!finished) { "AJB1_FINISHED" }
    var at = offset
    while (at < offset + length) {
      // A full buffer is sealed only once more data arrives, so the last
      // segment is always the final one (possibly empty).
      if (filled == buffer.size) seal(final = false)
      val take = minOf(buffer.size - filled, offset + length - at)
      System.arraycopy(bytes, at, buffer, filled, take)
      filled += take
      at += take
      plaintextBytes += take
    }
  }

  fun finish() {
    check(!finished) { "AJB1_FINISHED" }
    if (filled == buffer.size) seal(final = false)
    seal(final = true)
    finished = true
    buffer.fill(0)
  }

  private fun seal(final: Boolean) {
    val chunk = buffer.copyOf(filled)
    try {
      out.write(
          VaultCrypto.seal(
              dek,
              Ajb1.segmentNonce(noncePrefix, index),
              Ajb1.segmentAad(headerHash, index, final),
              chunk))
    } finally {
      chunk.fill(0)
    }
    index += 1
    filled = 0
  }
}

/**
 * Opens AJB1 segments in order from [input], positioned just after the
 * header. Any tag failure is `AUTH_FAILED` at stage `segment` (§9.3). With
 * [discard], plaintext is authenticated and dropped: the pass that runs
 * before any parsing, so a tampered archive never reaches the parser.
 */
class SegmentReader(
    private val input: InputStream,
    header: ByteArray,
    private val dek: ByteArray,
    private val segments: Long,
    private val bodyBytes: Long,
) {
  private val headerHash = Ajb1.sha256(header)
  private val noncePrefix = header.copyOfRange(48, 52)
  private var index = 0L
  private var current = ByteArray(0)
  private var position = 0

  /** True once every segment, the final one included, has been opened. */
  val exhausted: Boolean
    get() = index == segments && position == current.size

  private fun blockLength(i: Long): Int =
      if (i < segments - 1) Ajb1.BLOCK_BYTES
      else (bodyBytes - (segments - 1) * Ajb1.BLOCK_BYTES).toInt()

  /** Opens the next segment; false when there are none left. */
  private fun advance(): Boolean {
    if (index == segments) return false
    val sealed = ByteArray(blockLength(index))
    readFully(sealed)
    current.fill(0)
    current =
        try {
          VaultCrypto.open(
              dek,
              Ajb1.segmentNonce(noncePrefix, index),
              Ajb1.segmentAad(headerHash, index, index == segments - 1),
              sealed)
        } catch (_: AEADBadTagException) {
          throw Ajb1.Failure("AUTH_FAILED", "segment", index.toString())
        }
    position = 0
    index += 1
    return true
  }

  private fun readFully(target: ByteArray) {
    var at = 0
    while (at < target.size) {
      val count = input.read(target, at, target.size - at)
      if (count < 0) throw Ajb1.Failure("TRUNCATED", "segment")
      at += count
    }
  }

  /** Authenticates every remaining segment without keeping plaintext. */
  fun authenticateAll() {
    while (advance()) Unit
    current.fill(0)
  }

  /** Reads up to [length] plaintext bytes; -1 at the end of the stream. */
  fun read(target: ByteArray, offset: Int, length: Int): Int {
    while (position == current.size) {
      if (!advance()) return -1
    }
    val take = minOf(length, current.size - position)
    System.arraycopy(current, position, target, offset, take)
    position += take
    return take
  }

  /** Exactly [length] bytes, or [EOFException] when the stream ends first. */
  fun readExactly(target: ByteArray, offset: Int = 0, length: Int = target.size) {
    var at = 0
    while (at < length) {
      val count = read(target, offset + at, length - at)
      if (count < 0) throw EOFException()
      at += count
    }
  }

  fun close() {
    current.fill(0)
  }
}
