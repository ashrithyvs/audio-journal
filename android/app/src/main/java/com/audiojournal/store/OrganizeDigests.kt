package com.audiojournal.store

import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * journal.organize@1 digests (docs/journal-organize.md sections 2 and 9) with the
 * platform's own primitives: unit digests and the opaque request key.
 */
object OrganizeDigests {
  /** SHA-256 of the text's UTF-8 bytes, lower-case hex. */
  fun sha256Hex(text: String): String =
      MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).toHex()

  /** HMAC-SHA256(key, label || 0x00 || UTF-8 text), lower-case hex; the key is 32 bytes as hex. */
  fun hmacSha256Hex(keyHex: String, label: String, text: String): String {
    require(keyHex.length == 64 && keyHex.all { it in '0'..'9' || it in 'a'..'f' }) { "key" }
    val key = ByteArray(32) { keyHex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    try {
      val mac = Mac.getInstance("HmacSHA256")
      mac.init(SecretKeySpec(key, "HmacSHA256"))
      mac.update(label.toByteArray(Charsets.UTF_8))
      mac.update(0)
      return mac.doFinal(text.toByteArray(Charsets.UTF_8)).toHex()
    } finally {
      key.fill(0)
    }
  }

  private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
}
