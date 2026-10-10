package com.audiojournal.vault

import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** AES-256-GCM, HKDF-SHA256, and buffer hygiene for the vault (ADR-017). */
object VaultCrypto {
  const val KEY_BYTES = 32
  const val NONCE_BYTES = 12
  const val TAG_BITS = 128

  private val random = SecureRandom()

  fun randomBytes(count: Int): ByteArray = ByteArray(count).also { random.nextBytes(it) }

  /** Returns ciphertext followed by the 16-byte tag. */
  fun seal(key: ByteArray, nonce: ByteArray, aad: ByteArray, plaintext: ByteArray): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, nonce))
    cipher.updateAAD(aad)
    return cipher.doFinal(plaintext)
  }

  /** Throws [javax.crypto.AEADBadTagException] when authentication fails. */
  fun open(key: ByteArray, nonce: ByteArray, aad: ByteArray, sealed: ByteArray): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, nonce))
    cipher.updateAAD(aad)
    return cipher.doFinal(sealed)
  }

  /** HKDF-SHA256 (RFC 5869) with an all-zero salt and a UTF-8 label. */
  fun hkdf(ikm: ByteArray, info: String, length: Int = KEY_BYTES): ByteArray =
      hkdf(ikm, ByteArray(32), info.toByteArray(Charsets.UTF_8), length)

  /** HKDF-SHA256 (RFC 5869) with an explicit salt and binary info. */
  fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int = KEY_BYTES): ByteArray {
    require(salt.isNotEmpty()) { "HKDF salt" }
    val extract = Mac.getInstance("HmacSHA256")
    extract.init(SecretKeySpec(salt, "HmacSHA256"))
    val prk = extract.doFinal(ikm)
    val expand = Mac.getInstance("HmacSHA256")
    expand.init(SecretKeySpec(prk, "HmacSHA256"))
    val out = ByteArray(length)
    var previous = ByteArray(0)
    var written = 0
    var counter = 1
    while (written < length) {
      expand.update(previous)
      expand.update(info)
      expand.update(counter.toByte())
      previous = expand.doFinal()
      val take = minOf(previous.size, length - written)
      System.arraycopy(previous, 0, out, written, take)
      written += take
      counter += 1
    }
    zero(prk, previous)
    return out
  }

  fun zero(vararg buffers: ByteArray?) {
    for (buffer in buffers) buffer?.fill(0)
  }
}
