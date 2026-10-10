package com.audiojournal.vault

import java.nio.ByteBuffer

/**
 * Argon2id parameters, stored with the PIN copy and bound into its AAD.
 * Values are provisional until the lowest-supported-device benchmark
 * (ADR-017, Open decision 1); readers enforce [KdfPolicy] before any work.
 */
data class KdfParams(val memoryKiB: Int, val iterations: Int, val parallelism: Int) {
  val algorithm = ARGON2ID
  val version = ARGON2_VERSION_13

  companion object {
    const val ARGON2ID = 1
    const val ARGON2_VERSION_13 = 0x13
  }
}

/** Accepted bounds; a stored record outside them fails closed. */
data class KdfPolicy(val floor: KdfParams, val ceiling: KdfParams) {
  fun accepts(params: KdfParams): Boolean =
      params.memoryKiB in floor.memoryKiB..ceiling.memoryKiB &&
          params.iterations in floor.iterations..ceiling.iterations &&
          params.parallelism in floor.parallelism..ceiling.parallelism &&
          params.memoryKiB >= 8 * params.parallelism

  companion object {
    /** Provisional, matching the AJB1 vector policy; not a frozen budget. */
    val PROVISIONAL =
        KdfPolicy(floor = KdfParams(19_456, 2, 1), ceiling = KdfParams(1_048_576, 10, 4))
  }
}

/** The biometric copy of MK, wrapped by a biometric-bound Keystore key. */
class BiometricCopy(val iv: ByteArray, val wrapped: ByteArray)

/**
 * The vault file's inner record (ADR-017). The whole record is sealed by the
 * device Keystore key; the PIN copy is additionally sealed by the PIN KEK.
 * No PIN, KEK, or MK is ever stored in the clear.
 */
class VaultRecord(
    val kdf: KdfParams,
    val salt: ByteArray,
    val pinNonce: ByteArray,
    val pinWrapped: ByteArray,
    val failures: Int,
    val lastFailureAt: Long?,
    val biometric: BiometricCopy?,
) {
  fun copy(
      salt: ByteArray = this.salt,
      kdf: KdfParams = this.kdf,
      pinNonce: ByteArray = this.pinNonce,
      pinWrapped: ByteArray = this.pinWrapped,
      failures: Int = this.failures,
      lastFailureAt: Long? = this.lastFailureAt,
      biometric: BiometricCopy? = this.biometric,
  ) = VaultRecord(kdf, salt, pinNonce, pinWrapped, failures, lastFailureAt, biometric)

  /** AAD for the PIN copy: binds the KDF identity and parameters to MK. */
  fun pinAad(): ByteArray = pinAad(kdf, salt)

  fun encode(): ByteArray {
    val buffer = ByteBuffer.allocate(SIZE)
    buffer.put(MAGIC)
    buffer.putShort(FORMAT_VERSION.toShort())
    buffer.put(kdf.algorithm.toByte())
    buffer.put(kdf.version.toByte())
    buffer.putInt(kdf.memoryKiB)
    buffer.putInt(kdf.iterations)
    buffer.put(kdf.parallelism.toByte())
    buffer.put(salt)
    buffer.put(pinNonce)
    buffer.put(pinWrapped)
    buffer.putInt(failures)
    buffer.putLong(lastFailureAt ?: -1L)
    buffer.put((if (biometric == null) 0 else 1).toByte())
    buffer.put(biometric?.iv ?: ByteArray(BIO_IV_BYTES))
    buffer.put(biometric?.wrapped ?: ByteArray(WRAPPED_BYTES))
    return buffer.array()
  }

  companion object {
    private val MAGIC = byteArrayOf(0x41, 0x4a, 0x56, 0x31) // "AJV1"
    const val FORMAT_VERSION = 1
    const val SALT_BYTES = 16
    const val WRAPPED_BYTES = 48 // 32-byte MK + 16-byte tag
    const val BIO_IV_BYTES = 12
    const val SIZE = 4 + 2 + 1 + 1 + 4 + 4 + 1 + SALT_BYTES + 12 + WRAPPED_BYTES + 4 + 8 + 1 +
        BIO_IV_BYTES + WRAPPED_BYTES

    fun pinAad(kdf: KdfParams, salt: ByteArray): ByteArray =
        ByteBuffer.allocate(16 + 1 + 1 + 4 + 4 + 1 + SALT_BYTES)
            .put("aj-vault-pin-v1".toByteArray(Charsets.US_ASCII))
            .put(0.toByte()) // label terminator
            .put(kdf.algorithm.toByte())
            .put(kdf.version.toByte())
            .putInt(kdf.memoryKiB)
            .putInt(kdf.iterations)
            .put(kdf.parallelism.toByte())
            .put(salt)
            .array()

    /** Strict decoder: any unknown version or malformed field is rejected. */
    fun decode(bytes: ByteArray): VaultRecord {
      require(bytes.size == SIZE) { "vault record size" }
      val buffer = ByteBuffer.wrap(bytes)
      val magic = ByteArray(4).also { buffer.get(it) }
      require(magic.contentEquals(MAGIC)) { "vault magic" }
      require(buffer.short.toInt() == FORMAT_VERSION) { "vault version" }
      val algorithm = buffer.get().toInt()
      val version = buffer.get().toInt() and 0xff
      require(algorithm == KdfParams.ARGON2ID && version == KdfParams.ARGON2_VERSION_13) { "vault kdf" }
      val kdf = KdfParams(buffer.int, buffer.int, buffer.get().toInt() and 0xff)
      val salt = ByteArray(SALT_BYTES).also { buffer.get(it) }
      val pinNonce = ByteArray(12).also { buffer.get(it) }
      val pinWrapped = ByteArray(WRAPPED_BYTES).also { buffer.get(it) }
      val failures = buffer.int
      require(failures >= 0) { "vault failures" }
      val lastFailureAt = buffer.long.takeIf { it >= 0 }
      val hasBiometric = buffer.get().toInt()
      require(hasBiometric == 0 || hasBiometric == 1) { "vault biometric flag" }
      val bioIv = ByteArray(BIO_IV_BYTES).also { buffer.get(it) }
      val bioWrapped = ByteArray(WRAPPED_BYTES).also { buffer.get(it) }
      return VaultRecord(
          kdf,
          salt,
          pinNonce,
          pinWrapped,
          failures,
          lastFailureAt,
          if (hasBiometric == 1) BiometricCopy(bioIv, bioWrapped) else null)
    }
  }
}
