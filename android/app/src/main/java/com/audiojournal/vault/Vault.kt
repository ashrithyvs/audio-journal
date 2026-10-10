package com.audiojournal.vault

import java.io.File
import java.io.FileOutputStream
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher

/** Seals the vault record to this device (Android Keystore in production). */
interface DeviceSealer {
  fun seal(plaintext: ByteArray): ByteArray
  /** Throws when the device key is gone or the blob was altered. */
  fun open(sealed: ByteArray): ByteArray
  fun delete()
}

/** The PIN KEK function (libargon2 Argon2id in production). */
fun interface PinKdf {
  fun derive(pin: ByteArray, salt: ByteArray, params: KdfParams): ByteArray
}

/** Biometric-bound Keystore key; ciphers are authorized by BiometricPrompt. */
interface BiometricKeys {
  fun available(): Boolean
  fun create()
  fun encryptCipher(): Cipher
  /** Throws [android.security.keystore.KeyPermanentlyInvalidatedException] after enrollment changes. */
  fun decryptCipher(iv: ByteArray): Cipher
  fun delete()
}

sealed class PinResult {
  object Unlocked : PinResult()
  data class WrongPin(val retryAt: Long?) : PinResult()
  data class Refused(val retryAt: Long) : PinResult()
  object Unavailable : PinResult()
}

enum class VaultState { UNCONFIGURED, LOCKED, UNLOCKED, UNAVAILABLE }

/**
 * ADR-017 vault: a random master key (MK) wrapped twice, independently, by
 * the PIN KEK (inside the device-sealed record) and optionally by a
 * biometric-bound Keystore key. MK lives only in memory while unlocked.
 * Attempt policy: 5 free failures, then 30 s doubling to 1 h, persisted.
 */
class Vault(
    private val file: File,
    private val sealer: DeviceSealer,
    private val kdf: PinKdf,
    private val clock: () -> Long,
    private val newParams: KdfParams,
    private val policy: KdfPolicy = KdfPolicy.PROVISIONAL,
) {
  @Volatile private var masterKey: ByteArray? = null

  private fun read(): VaultRecord? {
    if (!file.exists()) return null
    val sealed = file.readBytes()
    val inner = sealer.open(sealed)
    try {
      return VaultRecord.decode(inner)
    } finally {
      VaultCrypto.zero(inner)
    }
  }

  /** Atomic replace: temp file, fsync, rename (ADR-017 PIN change). */
  private fun write(record: VaultRecord) {
    val inner = record.encode()
    val sealed = sealer.seal(inner)
    VaultCrypto.zero(inner)
    file.parentFile?.mkdirs()
    val temp = File(file.parentFile, "${file.name}.tmp")
    FileOutputStream(temp).use { out ->
      out.write(sealed)
      out.fd.sync()
    }
    check(temp.renameTo(file)) { "vault rename failed" }
  }

  @Synchronized
  fun state(): VaultState =
      when {
        masterKey != null -> VaultState.UNLOCKED
        !file.exists() -> VaultState.UNCONFIGURED
        else ->
            try {
              read()
              VaultState.LOCKED
            } catch (_: Exception) {
              VaultState.UNAVAILABLE
            }
      }

  @Synchronized
  fun retryAt(): Long? = read()?.let { retryAtFor(it, clock()) }

  @Synchronized
  fun hasBiometricCopy(): Boolean = (try { read() } catch (_: Exception) { null })?.biometric != null

  @Synchronized
  fun setupPin(pin: ByteArray) {
    check(!file.exists()) { "vault already configured" }
    require(policy.accepts(newParams)) { "kdf parameters outside policy" }
    val mk = VaultCrypto.randomBytes(VaultCrypto.KEY_BYTES)
    write(wrapForPin(mk, pin, base = null))
    masterKey = mk
  }

  @Synchronized
  fun unlockWithPin(pin: ByteArray): PinResult {
    val record = try { read() } catch (_: Exception) { return PinResult.Unavailable } ?: return PinResult.Unavailable
    if (!policy.accepts(record.kdf)) return PinResult.Unavailable
    val now = clock()
    var current = record
    if (current.lastFailureAt != null && now < current.lastFailureAt!!) {
      // A clock set back restarts the window instead of shortening it.
      current = current.copy(lastFailureAt = now)
      write(current)
    }
    retryAtFor(current, now)?.let { return PinResult.Refused(it) }
    val mk = unwrapWithPin(current, pin)
    if (mk == null) {
      val failed = current.copy(failures = current.failures + 1, lastFailureAt = now)
      write(failed)
      return PinResult.WrongPin(retryAtFor(failed, now))
    }
    if (current.kdf != newParams) {
      // Parameters changed (e.g. frozen after the device benchmark): rewrap
      // the PIN copy with the current ones; MK and data are unchanged.
      write(wrapForPin(mk, pin, base = current))
    } else if (current.failures != 0 || current.lastFailureAt != null) {
      write(current.copy(failures = 0, lastFailureAt = null))
    }
    masterKey = mk
    return PinResult.Unlocked
  }

  /** Verifies the current PIN under the attempt policy, then rewraps MK. */
  @Synchronized
  fun changePin(currentPin: ByteArray, nextPin: ByteArray): PinResult {
    val result = unlockWithPin(currentPin)
    if (result != PinResult.Unlocked) return result
    val record = read() ?: return PinResult.Unavailable
    // The biometric copy is untouched; only the PIN copy changes.
    write(wrapForPin(masterKey!!, nextPin, base = record))
    return PinResult.Unlocked
  }

  @Synchronized
  fun lock() {
    VaultCrypto.zero(masterKey)
    masterKey = null
  }

  /** Irreversible. The caller collected typed confirmation (ADR-017). */
  @Synchronized
  fun erase(biometric: BiometricKeys?) {
    lock()
    file.delete()
    File(file.parentFile, "${file.name}.tmp").delete()
    sealer.delete()
    biometric?.delete()
  }

  /** Purpose key (HKDF-SHA256 from MK); the caller zeroes it after use. */
  @Synchronized
  fun purposeKey(label: String): ByteArray {
    val mk = masterKey ?: throw IllegalStateException("STORE_LOCKED")
    return VaultCrypto.hkdf(mk, label)
  }

  // --- Biometric copy (convenience only; the PIN copy always remains) ---

  /** Wraps MK with an authorized encrypt cipher from BiometricPrompt. */
  @Synchronized
  fun storeBiometricCopy(cipher: Cipher) {
    val mk = masterKey ?: throw IllegalStateException("STORE_LOCKED")
    val record = read() ?: throw IllegalStateException("UNCONFIGURED")
    val wrapped = cipher.doFinal(mk)
    write(record.copy(biometric = BiometricCopy(cipher.iv, wrapped)))
  }

  @Synchronized
  fun biometricIv(): ByteArray? = read()?.biometric?.iv

  /** Unwraps MK with an authorized decrypt cipher; false if it fails. */
  @Synchronized
  fun unlockWithBiometricCipher(cipher: Cipher): Boolean {
    val copy = read()?.biometric ?: return false
    return try {
      masterKey = cipher.doFinal(copy.wrapped)
      true
    } catch (_: Exception) {
      false
    }
  }

  /** Enrollment changed or the user turned it off: drop the biometric copy. */
  @Synchronized
  fun removeBiometricCopy(keys: BiometricKeys?) {
    keys?.delete()
    val record = try { read() } catch (_: Exception) { null } ?: return
    if (record.biometric != null) write(record.copy(biometric = null))
  }

  private fun wrapForPin(mk: ByteArray, pin: ByteArray, base: VaultRecord?): VaultRecord {
    val salt = VaultCrypto.randomBytes(VaultRecord.SALT_BYTES)
    val nonce = VaultCrypto.randomBytes(VaultCrypto.NONCE_BYTES)
    val kek = kdf.derive(pin, salt, newParams)
    try {
      val wrapped = VaultCrypto.seal(kek, nonce, VaultRecord.pinAad(newParams, salt), mk)
      return VaultRecord(
          newParams, salt, nonce, wrapped, failures = 0, lastFailureAt = null,
          biometric = base?.biometric)
    } finally {
      VaultCrypto.zero(kek)
    }
  }

  private fun unwrapWithPin(record: VaultRecord, pin: ByteArray): ByteArray? {
    val kek = kdf.derive(pin, record.salt, record.kdf)
    return try {
      VaultCrypto.open(kek, record.pinNonce, record.pinAad(), record.pinWrapped)
    } catch (_: AEADBadTagException) {
      null
    } finally {
      VaultCrypto.zero(kek)
    }
  }

  companion object {
    const val FREE_FAILURES = 4
    const val FIRST_LOCKOUT_MS = 30_000L
    const val MAX_LOCKOUT_MS = 3_600_000L

    /** Same rule as src/features/journal/domain/unlockPolicy.ts. */
    fun lockoutMs(failures: Int): Long {
      val beyond = failures - FREE_FAILURES
      if (beyond < 1) return 0
      return minOf(FIRST_LOCKOUT_MS shl minOf(beyond - 1, 8), MAX_LOCKOUT_MS)
    }

    fun retryAtFor(record: VaultRecord, now: Long): Long? {
      val duration = lockoutMs(record.failures)
      val last = record.lastFailureAt ?: return null
      if (duration == 0L) return null
      val retryAt = last + duration
      return if (now >= retryAt) null else retryAt
    }
  }
}
