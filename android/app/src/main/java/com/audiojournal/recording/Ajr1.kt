package com.audiojournal.recording

import com.audiojournal.vault.VaultCrypto
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.security.MessageDigest
import javax.crypto.AEADBadTagException

/**
 * AJR1 recording container (ADR-017 as amended 2026-10-10; LLD §5.1).
 *
 * File = 64-byte header, then frames: `u64 index | u32 length | ciphertext
 * and 16-byte tag`. Each recording has its own key,
 * `HKDF-SHA256(recordingRootKey, fileSalt, encodedInfo)`, so the 4-byte nonce
 * prefix plus the u64 index never repeats under one key. Indices strictly
 * increase (gaps allowed). The AAD binds the header hash, recording ID, index,
 * and length. Plaintext PCM exists only in memory.
 */
object Ajr1 {
  const val HEADER_BYTES = 64
  const val FRAME_HEADER_BYTES = 12
  const val TAG_BYTES = 16
  const val SAMPLE_RATE = 16_000
  const val MAX_CHUNK_BYTES = 32_000 // 1 s of 16 kHz mono s16le
  const val MAX_INDEX = (1L shl 48) - 1
  const val KEY_LABEL = "audio-journal/ajr1/recording-key/v1"
  private val MAGIC = byteArrayOf(0x41, 0x4a, 0x52, 0x31) // "AJR1"

  class Header(val salt: ByteArray, val noncePrefix: ByteArray) {
    fun encode(): ByteArray =
        ByteBuffer.allocate(HEADER_BYTES)
            .put(MAGIC)
            .putShort(1.toShort())
            .putShort(HEADER_BYTES.toShort())
            .putInt(SAMPLE_RATE)
            .put(1.toByte()) // mono
            .put(1.toByte()) // s16le
            .putShort(0.toShort())
            .put(salt)
            .put(noncePrefix)
            .putInt(MAX_CHUNK_BYTES)
            .array() // remaining 24 bytes stay zero

    companion object {
      /** Strict: any unknown version, format, or nonzero reserved byte is rejected. */
      fun decode(bytes: ByteArray): Header {
        require(bytes.size >= HEADER_BYTES) { "AJR1_TRUNCATED" }
        val buffer = ByteBuffer.wrap(bytes, 0, HEADER_BYTES)
        val magic = ByteArray(4).also { buffer.get(it) }
        require(magic.contentEquals(MAGIC)) { "AJR1_NOT_AJR1" }
        require(buffer.short.toInt() == 1 && buffer.short.toInt() == HEADER_BYTES) { "AJR1_VERSION" }
        require(buffer.int == SAMPLE_RATE && buffer.get().toInt() == 1 && buffer.get().toInt() == 1) {
          "AJR1_FORMAT"
        }
        require(buffer.short.toInt() == 0) { "AJR1_RESERVED" }
        val salt = ByteArray(16).also { buffer.get(it) }
        val prefix = ByteArray(4).also { buffer.get(it) }
        require(buffer.int == MAX_CHUNK_BYTES) { "AJR1_FORMAT" }
        repeat(24) { require(buffer.get().toInt() == 0) { "AJR1_RESERVED" } }
        return Header(salt, prefix)
      }
    }
  }

  fun encodedInfo(recordingId: String): ByteArray {
    require(recordingId.matches(Regex("^rec_[0-9a-hjkmnp-tv-z]{26}$"))) { "AJR1_RECORDING_ID" }
    val label = KEY_LABEL.toByteArray(Charsets.US_ASCII)
    val id = recordingId.toByteArray(Charsets.US_ASCII)
    return ByteBuffer.allocate(2 + label.size + 2 + id.size)
        .putShort(label.size.toShort())
        .put(label)
        .putShort(id.size.toShort())
        .put(id)
        .array()
  }

  /** The per-recording key; the caller zeroes it when the recording closes. */
  fun fileKey(recordingRootKey: ByteArray, salt: ByteArray, recordingId: String): ByteArray =
      VaultCrypto.hkdf(recordingRootKey, salt, encodedInfo(recordingId))

  fun headerHash(header: ByteArray): ByteArray =
      MessageDigest.getInstance("SHA-256").digest(header.copyOf(HEADER_BYTES))

  fun nonce(prefix: ByteArray, index: Long): ByteArray =
      ByteBuffer.allocate(12).put(prefix).putLong(index).array()

  fun aad(headerHash: ByteArray, recordingId: String, index: Long, length: Int): ByteArray {
    val id = recordingId.toByteArray(Charsets.US_ASCII)
    return ByteBuffer.allocate(32 + 1 + id.size + 8 + 4)
        .put(headerHash)
        .put(id.size.toByte())
        .put(id)
        .putLong(index)
        .putInt(length)
        .array()
  }

  fun validLength(length: Int) = length in 2..MAX_CHUNK_BYTES && length % 2 == 0

  /** One sealed frame. */
  fun sealFrame(
      key: ByteArray,
      header: ByteArray,
      prefix: ByteArray,
      recordingId: String,
      index: Long,
      pcm: ByteArray,
  ): ByteArray {
    require(index in 0..MAX_INDEX) { "AJR1_INDEX_OVERFLOW" }
    require(validLength(pcm.size)) { "AJR1_CHUNK_LENGTH" }
    val sealed =
        VaultCrypto.seal(key, nonce(prefix, index), aad(headerHash(header), recordingId, index, pcm.size), pcm)
    return ByteBuffer.allocate(FRAME_HEADER_BYTES + sealed.size)
        .putLong(index)
        .putInt(pcm.size)
        .put(sealed)
        .array()
  }

  /** Random access to a recording's bytes: in memory (tests) or a file. */
  interface Source {
    val size: Long
    fun read(offset: Long, length: Int): ByteArray
  }

  class ArraySource(private val bytes: ByteArray) : Source {
    override val size = bytes.size.toLong()
    override fun read(offset: Long, length: Int) =
        bytes.copyOfRange(offset.toInt(), offset.toInt() + length)
  }

  /** Streams from disk so a 60-minute recording is never held in memory. */
  class FileSource(private val file: RandomAccessFile) : Source {
    override val size = file.length()
    override fun read(offset: Long, length: Int): ByteArray {
      val out = ByteArray(length)
      file.seek(offset)
      file.readFully(out)
      return out
    }
  }

  /** Result of authenticating a file from the start. */
  class Scan(
      val frames: Int,
      val lastIndex: Long?,
      val pcmBytes: Long,
      /** End of the last authenticated frame. */
      val validEnd: Long,
      /** Bytes after [validEnd]: a torn tail or damage. */
      val trailingBytes: Long,
      /** Index readable from a torn frame header, if any. */
      val tornIndex: Long?,
      /** Why scanning stopped before the end, if it did. */
      val stop: String?,
      val sha256: ByteArray,
  )

  /**
   * Authenticates frames in order and stops at the first frame that is torn,
   * fails authentication, or breaks ordering. [onPcm] receives each
   * authenticated chunk (playback, transcription, digest).
   */
  fun scan(
      file: ByteArray,
      recordingRootKey: ByteArray,
      recordingId: String,
      onPcm: (index: Long, pcm: ByteArray) -> Unit = { _, _ -> },
  ): Scan = scan(ArraySource(file), recordingRootKey, recordingId, onPcm)

  fun scan(
      source: Source,
      recordingRootKey: ByteArray,
      recordingId: String,
      onPcm: (index: Long, pcm: ByteArray) -> Unit = { _, _ -> },
  ): Scan {
    require(source.size >= HEADER_BYTES) { "AJR1_TRUNCATED" }
    val headerBytes = source.read(0, HEADER_BYTES)
    val header = Header.decode(headerBytes)
    val key = fileKey(recordingRootKey, header.salt, recordingId)
    val hash = headerHash(headerBytes)
    val digest = MessageDigest.getInstance("SHA-256")
    var at = HEADER_BYTES.toLong()
    var frames = 0
    var last: Long? = null
    var pcmBytes = 0L
    var stop: String? = null
    var tornIndex: Long? = null
    try {
      while (at < source.size) {
        val remaining = source.size - at
        if (remaining >= 8) tornIndex = ByteBuffer.wrap(source.read(at, 8)).long
        if (remaining < FRAME_HEADER_BYTES) {
          stop = "TORN"
          break
        }
        val frame = ByteBuffer.wrap(source.read(at, FRAME_HEADER_BYTES))
        val index = frame.long
        val length = frame.int
        if (index < 0 || index > MAX_INDEX) {
          stop = "INDEX_OVERFLOW"
          break
        }
        if (last != null && index <= last) {
          stop = "INDEX_ORDER"
          break
        }
        if (!validLength(length)) {
          stop = "CHUNK_LENGTH"
          break
        }
        val end = at + FRAME_HEADER_BYTES + length + TAG_BYTES
        if (end > source.size) {
          stop = "TORN"
          break
        }
        val sealed = source.read(at + FRAME_HEADER_BYTES, length + TAG_BYTES)
        val pcm =
            try {
              VaultCrypto.open(key, nonce(header.noncePrefix, index), aad(hash, recordingId, index, length), sealed)
            } catch (_: AEADBadTagException) {
              stop = "AUTH_FAILED"
              break
            }
        digest.update(pcm)
        onPcm(index, pcm)
        VaultCrypto.zero(pcm)
        frames += 1
        last = index
        pcmBytes += length
        at = end
        tornIndex = null
      }
    } finally {
      VaultCrypto.zero(key)
    }
    return Scan(frames, last, pcmBytes, at, source.size - at, tornIndex, stop, digest.digest())
  }

  /**
   * The next index after recovery. With a torn tail, the torn write may have
   * consumed `last + 1` (or a readable larger index), so it is never reused.
   */
  fun resumeIndex(scan: Scan): Long {
    val base = scan.lastIndex ?: -1L
    val next =
        if (scan.trailingBytes > 0) maxOf(base + 2, (scan.tornIndex?.takeIf { it in 0..MAX_INDEX } ?: -1L) + 1)
        else base + 1
    if (next > MAX_INDEX) throw IllegalStateException("AJR1_INDEX_OVERFLOW")
    return next
  }
}

/**
 * Appends sealed frames to one recording file. Holds the per-file key only
 * while open; [close] zeroes it (the vault also closes writers on lock).
 */
class Ajr1Writer private constructor(
    private val file: File,
    private val recordingId: String,
    private var key: ByteArray?,
    private val header: ByteArray,
    private val prefix: ByteArray,
    private var nextIndex: Long,
) : AutoCloseable {
  private val out = FileOutputStream(file, true)

  val index: Long
    get() = nextIndex

  /** Seals one chunk and forces it to storage: only complete frames count. */
  fun append(pcm: ByteArray) {
    val current = key ?: throw IllegalStateException("AJR1_CLOSED")
    if (nextIndex > Ajr1.MAX_INDEX) throw IllegalStateException("AJR1_INDEX_OVERFLOW")
    out.write(Ajr1.sealFrame(current, header, prefix, recordingId, nextIndex, pcm))
    out.fd.sync()
    nextIndex += 1
  }

  override fun close() {
    VaultCrypto.zero(key)
    key = null
    out.close()
  }

  companion object {
    /**
     * Creates a new file. A new or recreated file always gets a fresh salt,
     * so it never reuses a former key.
     */
    fun create(
        file: File,
        recordingId: String,
        recordingRootKey: ByteArray,
        random: (Int) -> ByteArray = VaultCrypto::randomBytes,
        firstIndex: Long = 0,
    ): Ajr1Writer {
      val header = Ajr1.Header(random(16), random(4))
      val bytes = header.encode()
      file.parentFile?.mkdirs()
      FileOutputStream(file, false).use {
        it.write(bytes)
        it.fd.sync()
      }
      return Ajr1Writer(
          file, recordingId, Ajr1.fileKey(recordingRootKey, header.salt, recordingId),
          bytes, header.noncePrefix, firstIndex)
    }

    /** Recovery: keeps authenticated frames, drops the torn tail, skips used indices. */
    fun resume(file: File, recordingId: String, recordingRootKey: ByteArray): Ajr1Writer {
      val (scan, headerBytes) =
          RandomAccessFile(file, "rw").use { raf ->
            val scan = Ajr1.scan(Ajr1.FileSource(raf), recordingRootKey, recordingId)
            val headerBytes = ByteArray(Ajr1.HEADER_BYTES).also {
              raf.seek(0)
              raf.readFully(it)
            }
            raf.setLength(scan.validEnd)
            raf.fd.sync()
            scan to headerBytes
          }
      val header = Ajr1.Header.decode(headerBytes)
      return Ajr1Writer(
          file, recordingId, Ajr1.fileKey(recordingRootKey, header.salt, recordingId),
          headerBytes, header.noncePrefix, Ajr1.resumeIndex(scan))
    }
  }
}
