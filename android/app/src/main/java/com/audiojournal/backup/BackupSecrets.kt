package com.audiojournal.backup

import java.security.MessageDigest
import java.text.Normalizer

/**
 * AJB1 secrets (§9.7). Mirrors `tools/ajb1-reference/lib/recoveryKey.mjs`.
 * Results carry typed reasons and never echo the secret.
 */
object BackupSecrets {
  const val WORDLIST_SHA256 = "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda"
  const val RECOVERY_KEY_WORDS = 24
  const val RECOVERY_KEY_BYTES = 32
  const val MIN_PASSWORD_CODE_POINTS = 12
  const val MAX_PASSWORD_BYTES = 1_024

  sealed class Decoded {
    class Ok(val bytes: ByteArray) : Decoded()

    class Rejected(val reason: String, val position: Int? = null) : Decoded()
  }

  /** The BIP-39 English list (MIT), refused unless it matches its pin. */
  class Wordlist(bytes: ByteArray) {
    val words: List<String>
    private val index: Map<String, Int>

    init {
      val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
      require(digest == WORDLIST_SHA256) { "WORDLIST_MISMATCH" }
      words = String(bytes, Charsets.US_ASCII).trimEnd().split('\n')
      require(words.size == 2_048) { "WORDLIST_MISMATCH" }
      index = words.withIndex().associate { it.value to it.index }
    }

    /** Canonical form: lower-case words joined by single spaces. */
    fun encode(entropy: ByteArray): String {
      require(entropy.size == RECOVERY_KEY_BYTES) { "RECOVERY_KEY_LENGTH" }
      val bits = bitsOf(entropy + checksum(entropy))
      return (0 until RECOVERY_KEY_WORDS).joinToString(" ") { words[bitsValue(bits, it * 11, 11)] }
    }

    /**
     * Trims, lower-cases ASCII letters only, and splits on ECMAScript
     * whitespace; each token must be an exact word, and the checksum must
     * match. No other leniency.
     */
    fun decode(text: String): Decoded {
      val lowered = text.map { if (it in 'A'..'Z') it + 32 else it }.joinToString("")
      val tokens = splitWhitespace(lowered)
      if (tokens.size != RECOVERY_KEY_WORDS) return Decoded.Rejected("WORD_COUNT")
      val bits = BooleanArray(RECOVERY_KEY_WORDS * 11)
      tokens.forEachIndexed { position, token ->
        val value = index[token] ?: return Decoded.Rejected("UNKNOWN_WORD", position)
        for (bit in 0 until 11) bits[position * 11 + bit] = (value shr (10 - bit)) and 1 == 1
      }
      val entropy = ByteArray(RECOVERY_KEY_BYTES) { bitsValue(bits, it * 8, 8).toByte() }
      if (bitsValue(bits, 256, 8) != checksum(entropy)[0].toInt() and 0xff) {
        return Decoded.Rejected("CHECKSUM")
      }
      return Decoded.Ok(entropy)
    }
  }

  /** KDF input for a password: NFC, then UTF-8 (§9.7). */
  fun password(text: String): Decoded {
    val normalized = Normalizer.normalize(text, Normalizer.Form.NFC)
    val bytes = normalized.toByteArray(Charsets.UTF_8)
    if (normalized.codePointCount(0, normalized.length) < MIN_PASSWORD_CODE_POINTS) {
      return Decoded.Rejected("WEAK_PASSWORD")
    }
    if (bytes.size > MAX_PASSWORD_BYTES) return Decoded.Rejected("TOO_LONG")
    return Decoded.Ok(bytes)
  }

  private fun checksum(entropy: ByteArray) =
      byteArrayOf(MessageDigest.getInstance("SHA-256").digest(entropy)[0])

  private fun bitsOf(bytes: ByteArray) =
      BooleanArray(bytes.size * 8) { (bytes[it / 8].toInt() shr (7 - it % 8)) and 1 == 1 }

  private fun bitsValue(bits: BooleanArray, from: Int, count: Int): Int {
    var value = 0
    for (i in from until from + count) value = (value shl 1) or (if (bits[i]) 1 else 0)
    return value
  }

  /**
   * ECMAScript WhiteSpace and LineTerminator (what `\s` and `trim()` match),
   * which the reference and the AJB1 rules use; Java's own whitespace
   * classes differ.
   */
  fun isEcmaWhitespace(c: Char): Boolean =
          c == '\t' || c == '\n' || c == '\u000b' || c == '\u000c' || c == '\r' || c == ' ' ||
          c == '\u00a0' || c == '\u1680' || c in '\u2000'..'\u200a' || c == '\u2028' ||
          c == '\u2029' || c == '\u202f' || c == '\u205f' || c == '\u3000' || c == '\ufeff'

  fun splitWhitespace(text: String): List<String> {
    val out = ArrayList<String>()
    val current = StringBuilder()
    for (c in text) {
      if (isEcmaWhitespace(c)) {
        if (current.isNotEmpty()) out.add(current.toString())
        current.setLength(0)
      } else {
        current.append(c)
      }
    }
    if (current.isNotEmpty()) out.add(current.toString())
    return out
  }

  /** `text.replace(/\s+/g, ' ').trim()` in ECMAScript terms. */
  fun collapseWhitespace(text: String): String = splitWhitespace(text).joinToString(" ")

  fun isBlank(text: String): Boolean = text.all(::isEcmaWhitespace)
}
