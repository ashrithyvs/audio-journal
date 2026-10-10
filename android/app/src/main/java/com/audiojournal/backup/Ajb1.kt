package com.audiojournal.backup

import com.audiojournal.vault.KdfParams
import com.audiojournal.vault.VaultCrypto
import java.nio.ByteBuffer
import java.security.MessageDigest
import javax.crypto.AEADBadTagException

/**
 * AJB1 container version 1 (docs/backup-and-restore.md §9, frozen for
 * implementation). Mirrors `tools/ajb1-reference/lib/ajb1.mjs`, but streams:
 * no whole archive or plaintext is ever held in memory.
 */
object Ajb1 {
  val MAGIC = byteArrayOf(0x41, 0x4a, 0x42, 0x31, 0x0d, 0x0a, 0x1a, 0x0a)
  const val FORMAT_VERSION = 1
  const val HEADER_BYTES = 128
  const val SEGMENT_BYTES = 1_048_576
  const val TAG_BYTES = 16
  const val BLOCK_BYTES = SEGMENT_BYTES + TAG_BYTES
  const val KDF_ARGON2ID = 1
  const val KDF_VERSION = 0x13
  const val AEAD_AES_256_GCM = 1
  const val SECRET_PASSWORD = 1
  const val SECRET_RECOVERY_KEY = 2
  const val DOMAIN_SCHEMA_VERSION = 1
  const val SECTION_MANIFEST = 1
  const val SECTION_RECORDS = 2
  const val SECTION_RECORDING = 3
  const val SECTION_END = 4
  const val SECTION_HEADER_BYTES = 12
  const val ID_BYTES = 30

  /** A typed rejection: `code` and `stage` as in the vectors; never content. */
  class Failure(val code: String, val stage: String, val detail: String? = null) :
      Exception(code)

  /**
   * Argon2id bounds. PROVISIONAL and injectable (§9.8): frozen only from the
   * lowest-supported physical Android device benchmark, never the emulator.
   */
  class KdfPolicy(val floor: KdfParams, val ceiling: KdfParams) {
    fun accepts(params: KdfParams) =
        params.memoryKiB in floor.memoryKiB..ceiling.memoryKiB &&
            params.iterations in floor.iterations..ceiling.iterations &&
            params.parallelism in floor.parallelism..ceiling.parallelism &&
            params.memoryKiB >= 8 * params.parallelism

    companion object {
      val PROVISIONAL = KdfPolicy(KdfParams(19_456, 2, 1), KdfParams(1_048_576, 10, 4))
    }
  }

  /** §9.8 v0.1 limits; injectable for tests. */
  class Limits(
      val maxArchiveBytes: Long = 34L shl 30,
      val maxManifestBytes: Long = 64L shl 10,
      val maxRecordsBytes: Long = 1L shl 30,
      val maxLineBytes: Int = 2 shl 20,
      val maxEntries: Long = 100_000,
      val maxRecordings: Long = 100_000,
      val maxTranscriptSegments: Long = 4_000_000,
      val maxRecordingDurationMs: Long = 3_600_000,
      val maxRecordingPcmBytes: Long = 115_200_032,
      val maxTotalPcmBytes: Long = 32L shl 30,
      val restoreReserveBytes: Long = 512L shl 20,
      val exportReserveBytes: Long = 256L shl 20,
  ) {
    companion object {
      val V1 = Limits()
    }
  }

  class HeaderInfo(
      val kdf: KdfParams,
      val salt: ByteArray,
      val secretKind: Int,
      val domainSchemaVersion: Int,
      val noncePrefix: ByteArray,
      /** Number of segments, the final one included. */
      val segments: Long,
  )

  fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

  fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

  /**
   * Every check that needs no secret, in §9.10 order. [header] holds up to
   * the first 128 bytes of the file; [fileBytes] is its full size.
   */
  fun precheck(
      header: ByteArray,
      fileBytes: Long,
      secretKind: Int? = null,
      policy: KdfPolicy = KdfPolicy.PROVISIONAL,
      restoreAvailableBytes: Long? = null,
      maxDomainSchema: Int = DOMAIN_SCHEMA_VERSION,
      limits: Limits = Limits.V1,
  ): HeaderInfo {
    val stage = "header"
    if (fileBytes < MAGIC.size || !header.copyOf(MAGIC.size).contentEquals(MAGIC)) {
      throw Failure("NOT_AJB1", stage)
    }
    if (fileBytes < HEADER_BYTES + TAG_BYTES || header.size < HEADER_BYTES) {
      throw Failure("TRUNCATED", stage)
    }
    if (fileBytes > limits.maxArchiveBytes) throw Failure("LIMIT_EXCEEDED", stage, "archive size")
    val buffer = ByteBuffer.wrap(header, 0, HEADER_BYTES)
    if (u16(header, 8) != FORMAT_VERSION) throw Failure("UNSUPPORTED_VERSION", stage)
    val domain = u16(header, 42)
    if (u16(header, 10) != HEADER_BYTES ||
        header[15].toInt() != 0 ||
        (112 until 128).any { header[it].toInt() != 0 } ||
        u8(header, 40) != AEAD_AES_256_GCM ||
        u8(header, 41) !in listOf(SECRET_PASSWORD, SECRET_RECOVERY_KEY) ||
        buffer.getInt(44) != SEGMENT_BYTES ||
        domain == 0) {
      throw Failure("MALFORMED_HEADER", stage)
    }
    if (domain > maxDomainSchema) throw Failure("UNSUPPORTED_SCHEMA", stage)
    if (u8(header, 12) != KDF_ARGON2ID || u8(header, 13) != KDF_VERSION) {
      throw Failure("UNSUPPORTED_KDF", stage)
    }
    val memory = buffer.getInt(16).toLong() and 0xffffffffL
    val iterations = buffer.getInt(20).toLong() and 0xffffffffL
    val parallelism = u8(header, 14)
    if (memory > Int.MAX_VALUE || iterations > Int.MAX_VALUE) throw Failure("KDF_PARAMS_REJECTED", stage)
    val kdf = KdfParams(memory.toInt(), iterations.toInt(), parallelism)
    if (!policy.accepts(kdf)) throw Failure("KDF_PARAMS_REJECTED", stage)
    // Canonical layout: full blocks of L + 16, then a final block of 16..L+15.
    val body = fileBytes - HEADER_BYTES
    if (body % BLOCK_BYTES < TAG_BYTES) throw Failure("TRUNCATED", stage)
    if (restoreAvailableBytes != null && restoreAvailableBytes < fileBytes + limits.restoreReserveBytes) {
      throw Failure("INSUFFICIENT_STORAGE", stage)
    }
    val kind = u8(header, 41)
    if (secretKind != null && secretKind != kind) throw Failure("SECRET_KIND_MISMATCH", stage)
    return HeaderInfo(
        kdf, header.copyOfRange(24, 40), kind, domain, header.copyOfRange(48, 52), body / BLOCK_BYTES + 1)
  }

  fun buildHeader(
      kdf: KdfParams,
      salt: ByteArray,
      secretKind: Int,
      domainSchemaVersion: Int,
      noncePrefix: ByteArray,
      wrapNonce: ByteArray,
      kek: ByteArray,
      dek: ByteArray,
  ): ByteArray {
    require(salt.size == 16 && noncePrefix.size == 4 && wrapNonce.size == 12 && dek.size == 32)
    val header =
        ByteBuffer.allocate(HEADER_BYTES)
            .put(MAGIC)
            .putShort(FORMAT_VERSION.toShort())
            .putShort(HEADER_BYTES.toShort())
            .put(KDF_ARGON2ID.toByte())
            .put(KDF_VERSION.toByte())
            .put(kdf.parallelism.toByte())
            .put(0.toByte())
            .putInt(kdf.memoryKiB)
            .putInt(kdf.iterations)
            .put(salt)
            .put(AEAD_AES_256_GCM.toByte())
            .put(secretKind.toByte())
            .putShort(domainSchemaVersion.toShort())
            .putInt(SEGMENT_BYTES)
            .put(noncePrefix)
            .put(wrapNonce)
            .array()
    val wrapped = VaultCrypto.seal(kek, wrapNonce, header.copyOf(64), dek)
    System.arraycopy(wrapped, 0, header, 64, wrapped.size)
    return header
  }

  /** The DEK, or `AUTH_FAILED` at `unwrap` (wrong secret or altered header). */
  fun unwrapDek(header: ByteArray, kek: ByteArray): ByteArray =
      try {
        VaultCrypto.open(kek, header.copyOfRange(52, 64), header.copyOf(64), header.copyOfRange(64, 112))
      } catch (_: AEADBadTagException) {
        throw Failure("AUTH_FAILED", "unwrap")
      }

  fun segmentNonce(prefix: ByteArray, index: Long): ByteArray =
      ByteBuffer.allocate(12).put(prefix).putLong(index).array()

  fun segmentAad(headerHash: ByteArray, index: Long, final: Boolean): ByteArray =
      ByteBuffer.allocate(41).put(headerHash).putLong(index).put((if (final) 1 else 0).toByte()).array()

  private fun u8(bytes: ByteArray, at: Int) = bytes[at].toInt() and 0xff

  private fun u16(bytes: ByteArray, at: Int) = (u8(bytes, at) shl 8) or u8(bytes, at + 1)
}
