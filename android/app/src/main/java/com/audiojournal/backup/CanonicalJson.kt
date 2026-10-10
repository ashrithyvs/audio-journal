package com.audiojournal.backup

/**
 * AJ canonical JSON v1 (AJB1 §9.4): an RFC 8785 (JCS) profile. Values are
 * objects, arrays, strings, booleans, and integers 0..2^53-1; `null`,
 * fractions, exponents, and negatives are outside the profile. Object members
 * are sorted by UTF-16 code units. Decoding is strict: no duplicate key at
 * any depth, and the input must equal the canonical serialization of what it
 * decodes to. Mirrors `tools/ajb1-reference/lib/canonicalJson.mjs`.
 *
 * Objects decode to [LinkedHashMap] (String keys), arrays to [List], integers
 * to [Long].
 */
object CanonicalJson {
  const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

  class Failure(val reason: String) : Exception(reason)

  fun serialize(value: Any?): String = StringBuilder().also { write(it, value) }.toString()

  private fun write(out: StringBuilder, value: Any?) {
    when (value) {
      is String -> quote(out, value)
      is Boolean -> out.append(if (value) "true" else "false")
      is Int -> write(out, value.toLong())
      is Long -> {
        if (value < 0 || value > MAX_SAFE_INTEGER) throw Failure("NUMBER_OUT_OF_PROFILE")
        out.append(value)
      }
      is List<*> -> {
        out.append('[')
        value.forEachIndexed { i, item ->
          if (i > 0) out.append(',')
          write(out, item)
        }
        out.append(']')
      }
      is Map<*, *> -> {
        out.append('{')
        // String.compareTo orders by UTF-16 code units, as JCS requires.
        value.keys.map { it as? String ?: throw Failure("UNSUPPORTED_TYPE") }.sorted().forEachIndexed {
            i, key ->
          if (i > 0) out.append(',')
          quote(out, key)
          out.append(':')
          write(out, value[key] ?: throw Failure("UNDEFINED_VALUE"))
        }
        out.append('}')
      }
      null -> throw Failure("NULL_NOT_ALLOWED")
      else -> throw Failure("UNSUPPORTED_TYPE")
    }
  }

  private fun quote(out: StringBuilder, text: String) {
    out.append('"')
    var i = 0
    while (i < text.length) {
      val c = text[i]
      when {
        Character.isHighSurrogate(c) -> {
          if (i + 1 >= text.length || !Character.isLowSurrogate(text[i + 1])) {
            throw Failure("LONE_SURROGATE")
          }
          out.append(c).append(text[i + 1])
          i += 1
        }
        Character.isLowSurrogate(c) -> throw Failure("LONE_SURROGATE")
        c == '"' -> out.append("\\\"")
        c == '\\' -> out.append("\\\\")
        c == '\b' -> out.append("\\b")
        c == '\t' -> out.append("\\t")
        c == '\n' -> out.append("\\n")
        c == '\u000c' -> out.append("\\f")
        c == '\r' -> out.append("\\r")
        c < ' ' -> out.append("\\u00").append(HEX[c.code shr 4]).append(HEX[c.code and 0xf])
        else -> out.append(c)
      }
      i += 1
    }
    out.append('"')
  }

  private val HEX = "0123456789abcdef".toCharArray()

  /** Strict decode of one document; see the class comment. */
  fun parse(text: String, maxDepth: Int = 8): Any {
    val value = Parser(text, maxDepth).document()
    if (serialize(value) != text) throw Failure("NON_CANONICAL")
    return value
  }

  private class Parser(private val text: String, private val maxDepth: Int) {
    private var at = 0

    fun document(): Any {
      val value = value(0)
      if (at != text.length) throw Failure("TRAILING_DATA")
      return value
    }

    private fun expect(char: Char) {
      if (at >= text.length || text[at] != char) throw Failure("SYNTAX")
      at += 1
    }

    private fun value(depth: Int): Any {
      if (depth > maxDepth) throw Failure("TOO_DEEP")
      if (at >= text.length) throw Failure("SYNTAX")
      return when (val c = text[at]) {
        '{' -> obj(depth)
        '[' -> array(depth)
        '"' -> string()
        else ->
            when {
              text.startsWith("true", at) -> true.also { at += 4 }
              text.startsWith("false", at) -> false.also { at += 5 }
              text.startsWith("null", at) -> throw Failure("NULL_NOT_ALLOWED")
              c == '-' || c in '0'..'9' -> number()
              else -> throw Failure("SYNTAX")
            }
      }
    }

    private fun obj(depth: Int): Map<String, Any> {
      expect('{')
      val out = LinkedHashMap<String, Any>()
      if (at < text.length && text[at] == '}') {
        at += 1
        return out
      }
      while (true) {
        val key = string()
        if (out.containsKey(key)) throw Failure("DUPLICATE_KEY")
        expect(':')
        out[key] = value(depth + 1)
        if (at < text.length && text[at] == ',') {
          at += 1
        } else {
          expect('}')
          return out
        }
      }
    }

    private fun array(depth: Int): List<Any> {
      expect('[')
      val out = ArrayList<Any>()
      if (at < text.length && text[at] == ']') {
        at += 1
        return out
      }
      while (true) {
        out.add(value(depth + 1))
        if (at < text.length && text[at] == ',') {
          at += 1
        } else {
          expect(']')
          return out
        }
      }
    }

    private fun string(): String {
      expect('"')
      val out = StringBuilder()
      while (true) {
        if (at >= text.length) throw Failure("SYNTAX")
        val c = text[at]
        when {
          c == '"' -> {
            at += 1
            return out.toString()
          }
          c == '\\' -> {
            val next = if (at + 1 < text.length) text[at + 1] else throw Failure("SYNTAX")
            val simple =
                when (next) {
                  '"' -> '"'
                  '\\' -> '\\'
                  '/' -> '/'
                  'b' -> '\b'
                  'f' -> '\u000c'
                  'n' -> '\n'
                  'r' -> '\r'
                  't' -> '\t'
                  else -> null
                }
            if (simple != null) {
              out.append(simple)
              at += 2
            } else if (next == 'u' && at + 6 <= text.length && text.substring(at + 2, at + 6).all {
                  it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F'
                }) {
              out.append(text.substring(at + 2, at + 6).toInt(16).toChar())
              at += 6
            } else {
              throw Failure("SYNTAX")
            }
          }
          c < ' ' -> throw Failure("UNESCAPED_CONTROL")
          else -> {
            out.append(c)
            at += 1
          }
        }
      }
    }

    /** Same grammar as the reference: JSON numbers, then the profile check. */
    private fun number(): Long {
      val start = at
      if (text[at] == '-') at += 1
      if (at < text.length && text[at] == '0') {
        at += 1
      } else if (at < text.length && text[at] in '1'..'9') {
        while (at < text.length && text[at] in '0'..'9') at += 1
      } else {
        throw Failure("SYNTAX")
      }
      var fraction = false
      if (at + 1 < text.length && text[at] == '.' && text[at + 1] in '0'..'9') {
        fraction = true
        at += 1
        while (at < text.length && text[at] in '0'..'9') at += 1
      }
      var exponent = false
      if (at < text.length && (text[at] == 'e' || text[at] == 'E')) {
        var probe = at + 1
        if (probe < text.length && (text[probe] == '+' || text[probe] == '-')) probe += 1
        if (probe < text.length && text[probe] in '0'..'9') {
          exponent = true
          at = probe
          while (at < text.length && text[at] in '0'..'9') at += 1
        }
      }
      val literal = text.substring(start, at)
      if (literal.startsWith("-") || fraction || exponent) throw Failure("NUMBER_OUT_OF_PROFILE")
      // Beyond 2^53 - 1 cannot round-trip; the reference rejects it the same way.
      return literal.toBigInteger().takeIf { it <= MAX_SAFE_INTEGER.toBigInteger() }?.toLong()
          ?: throw Failure("NUMBER_OUT_OF_PROFILE")
    }
  }
}
