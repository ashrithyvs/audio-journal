package com.audiojournal.backup

import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.nio.ByteBuffer
import java.security.MessageDigest

/** Receives a validated archive as it is read (restore staging, verification). */
interface ArchiveSink {
  fun record(record: Map<String, Any>) {}

  /** Every record passed the cross-record checks; PCM follows. */
  fun recordsChecked(relations: Ajb1Records.Relations) {}

  fun recordingStart(recording: Map<String, Any>) {}

  fun pcm(bytes: ByteArray, offset: Int, length: Int) {}

  fun recordingEnd(recording: Map<String, Any>) {}
}

/**
 * Reads the decrypted section stream (§9.3–9.6) with bounded memory and
 * reaches the same verdict as the reference's whole-buffer parser: errors
 * inside RECORDS are reported only after the section's digest, UTF-8, and
 * final-LF checks, in the reference's order. Call only after every segment
 * has authenticated ([SegmentReader.authenticateAll] on a first pass).
 */
class Ajb1Parser(
    private val reader: SegmentReader,
    private val domainSchemaVersion: Int,
    private val limits: Ajb1.Limits = Ajb1.Limits.V1,
    private val checkpoint: (String) -> Unit = {},
) {
  private class Head(val kind: Int, val length: Long)

  private fun next(): Head {
    val bytes = ByteArray(Ajb1.SECTION_HEADER_BYTES)
    try {
      reader.readExactly(bytes)
    } catch (_: EOFException) {
      throw Ajb1.Failure("MALFORMED_SECTION", "sections", "short section header")
    }
    if (bytes[1].toInt() != 0 || bytes[2].toInt() != 0 || bytes[3].toInt() != 0) {
      throw Ajb1.Failure("MALFORMED_SECTION", "sections", "reserved bytes")
    }
    // Unsigned u64: a value above Long.MAX_VALUE is simply too long.
    val length = ByteBuffer.wrap(bytes, 4, 8).long.let { if (it < 0) Long.MAX_VALUE else it }
    return Head(bytes[0].toInt() and 0xff, length)
  }

  private fun readBody(length: Int, stage: String): ByteArray {
    val out = ByteArray(length)
    try {
      reader.readExactly(out)
    } catch (_: EOFException) {
      throw Ajb1.Failure("MALFORMED_SECTION", stage, "section overruns stream")
    }
    return out
  }

  /**
   * Reads and validates only the first section: enough for the restore
   * preview (date, counts, sizes) before anything is staged.
   */
  fun manifestOnly(): Map<String, Any> {
    val head = next()
    if (head.kind != Ajb1.SECTION_MANIFEST) {
      throw Ajb1.Failure("MALFORMED_SECTION", "sections", "manifest first")
    }
    if (head.length > limits.maxManifestBytes) {
      throw Ajb1.Failure("LIMIT_EXCEEDED", "manifest", "section length")
    }
    val manifestBytes = readBody(head.length.toInt(), "manifest")
    val validator = Utf8Validator().apply { update(manifestBytes, 0, manifestBytes.size) }
    if (!validator.finish()) throw Ajb1.Failure("NON_CANONICAL_JSON", "manifest", "invalid UTF-8")
    val manifest =
        try {
          CanonicalJson.parse(String(manifestBytes, Charsets.UTF_8))
        } catch (failure: CanonicalJson.Failure) {
          throw Ajb1.Failure("NON_CANONICAL_JSON", "manifest", failure.reason)
        }
    Ajb1Records.checkManifest(manifest, domainSchemaVersion, limits)
    @Suppress("UNCHECKED_CAST")
    return manifest as Map<String, Any>
  }

  /** Returns the manifest; everything else goes to [sink]. */
  fun parse(sink: ArchiveSink = object : ArchiveSink {}): Map<String, Any> {
    val parsed = manifestOnly()
    val records = parsed["records"] as Map<*, *>
    checkpoint("manifest")

    var head = next()
    if (head.kind != Ajb1.SECTION_RECORDS) {
      throw Ajb1.Failure("MALFORMED_SECTION", "sections", "records second")
    }
    if (head.length != records["bytes"]) {
      throw Ajb1.Failure("COUNT_MISMATCH", "records", "records length")
    }
    if (head.length > limits.maxRecordsBytes) {
      throw Ajb1.Failure("LIMIT_EXCEEDED", "records", "section length")
    }
    val relations = readRecords(head.length, records["sha256"] as String, sink)
    if (relations.counts != records["counts"]) throw Ajb1.Failure("COUNT_MISMATCH", "records")
    relations.check()
    if (relations.pcmBytes != (parsed["pcm"] as Map<*, *>)["bytes"]) {
      throw Ajb1.Failure("COUNT_MISMATCH", "records", "pcm bytes")
    }
    sink.recordsChecked(relations)
    checkpoint("records")

    val buffer = ByteArray(64 * 1024)
    for ((id, recording) in relations.recordings) {
      head = next()
      if (head.kind != Ajb1.SECTION_RECORDING) {
        throw Ajb1.Failure("MALFORMED_SECTION", "recordings", "expected recording")
      }
      val pcmBytes = recording["pcmBytes"] as Long
      if (head.length != Ajb1.ID_BYTES + pcmBytes) {
        throw Ajb1.Failure("MALFORMED_SECTION", "recordings", "recording length")
      }
      val idBytes = readBody(Ajb1.ID_BYTES, "recordings")
      if (String(idBytes, Charsets.ISO_8859_1) != id) {
        throw Ajb1.Failure("MALFORMED_SECTION", "recordings", "recording order")
      }
      sink.recordingStart(recording)
      val digest = MessageDigest.getInstance("SHA-256")
      var remaining = pcmBytes
      while (remaining > 0) {
        val take = minOf(buffer.size.toLong(), remaining).toInt()
        try {
          reader.readExactly(buffer, 0, take)
        } catch (_: EOFException) {
          throw Ajb1.Failure("MALFORMED_SECTION", "recordings", "section overruns stream")
        }
        digest.update(buffer, 0, take)
        sink.pcm(buffer, 0, take)
        remaining -= take
      }
      buffer.fill(0)
      if (Ajb1.hex(digest.digest()) != recording["pcmSha256"]) {
        throw Ajb1.Failure("DIGEST_MISMATCH", "recordings")
      }
      sink.recordingEnd(recording)
      checkpoint("recording")
    }

    head = next()
    if (head.kind != Ajb1.SECTION_END || head.length != 0L) {
      throw Ajb1.Failure("MALFORMED_SECTION", "sections", "expected end")
    }
    if (reader.read(ByteArray(1), 0, 1) != -1 || !reader.exhausted) {
      throw Ajb1.Failure("MALFORMED_SECTION", "sections", "data after end")
    }
    return parsed
  }

  /**
   * Streams RECORDS line by line. Line errors are held until the whole
   * section has been hashed and UTF-8-checked, matching the reference order:
   * overrun, digest, UTF-8, final LF, then the first line's own error.
   */
  private fun readRecords(length: Long, sha256: String, sink: ArchiveSink): Ajb1Records.Relations {
    val digest = MessageDigest.getInstance("SHA-256")
    val utf8 = Utf8Validator()
    val relations = Ajb1Records.Relations()
    val ids = HashSet<String>()
    var previous: Map<String, Any>? = null
    var lineError: Ajb1.Failure? = null
    val line = ByteArrayOutputStream()
    var lineTooLong = false
    var lastByte = -1
    val chunk = ByteArray(64 * 1024)

    fun endLine() {
      val bytes = line.toByteArray()
      line.reset()
      if (lineError != null) return
      if (lineTooLong) {
        lineError = Ajb1.Failure("NON_CANONICAL_JSON", "records", "LINE_TOO_LONG")
        return
      }
      if (bytes.isEmpty()) {
        lineError = Ajb1.Failure("NON_CANONICAL_JSON", "records", "EMPTY_LINE")
        return
      }
      val lineValidator = Utf8Validator().apply { update(bytes, 0, bytes.size) }
      if (!lineValidator.finish()) return // reported for the whole section below
      val value =
          try {
            CanonicalJson.parse(String(bytes, Charsets.UTF_8))
          } catch (failure: CanonicalJson.Failure) {
            lineError = Ajb1.Failure("NON_CANONICAL_JSON", "records", failure.reason)
            return
          }
      @Suppress("UNCHECKED_CAST")
      val record =
          value as? Map<String, Any>
              ?: run {
                lineError = Ajb1.Failure("NON_CANONICAL_JSON", "records", "RECORD_NOT_OBJECT")
                return
              }
      Ajb1Records.check(record, limits)?.let {
        lineError = Ajb1.Failure("INVALID_RECORD", "records", it)
        return
      }
      val id = record["id"] as String
      if (!ids.add(id)) {
        lineError = Ajb1.Failure("DUPLICATE_ID", "records", id.take(4))
        return
      }
      if (previous != null && !Ajb1Records.inOrder(previous!!, record)) {
        lineError = Ajb1.Failure("INVALID_RECORD", "records", "NON_CANONICAL_ORDER")
        return
      }
      previous = record
      relations.add(record)
      sink.record(record)
    }

    var remaining = length
    while (remaining > 0) {
      val take = minOf(chunk.size.toLong(), remaining).toInt()
      try {
        reader.readExactly(chunk, 0, take)
      } catch (_: EOFException) {
        throw Ajb1.Failure("MALFORMED_SECTION", "records", "section overruns stream")
      }
      digest.update(chunk, 0, take)
      utf8.update(chunk, 0, take)
      for (i in 0 until take) {
        val b = chunk[i].toInt() and 0xff
        if (b == 0x0a) {
          endLine()
          lineTooLong = false
        } else if (!lineTooLong) {
          if (line.size() >= limits.maxLineBytes) {
            lineTooLong = true
            line.reset()
          } else {
            line.write(b)
          }
        }
        lastByte = b
      }
      remaining -= take
    }
    chunk.fill(0)
    if (Ajb1.hex(digest.digest()) != sha256) throw Ajb1.Failure("DIGEST_MISMATCH", "records")
    if (!utf8.finish()) throw Ajb1.Failure("NON_CANONICAL_JSON", "records", "invalid UTF-8")
    if (length > 0 && lastByte != 0x0a) {
      throw Ajb1.Failure("NON_CANONICAL_JSON", "records", "MISSING_FINAL_LF")
    }
    lineError?.let { throw it }
    return relations
  }
}

/** Strict UTF-8 (WHATWG decoder rules): no overlongs, surrogates, or > U+10FFFF. */
class Utf8Validator {
  private var need = 0
  private var lower = 0x80
  private var upper = 0xbf
  private var valid = true

  fun update(bytes: ByteArray, offset: Int, length: Int) {
    for (i in offset until offset + length) {
      if (!valid) return
      val b = bytes[i].toInt() and 0xff
      if (need == 0) {
        when (b) {
          in 0x00..0x7f -> Unit
          in 0xc2..0xdf -> need = 1
          0xe0 -> {
            need = 2
            lower = 0xa0
          }
          in 0xe1..0xec, 0xee, 0xef -> need = 2
          0xed -> {
            need = 2
            upper = 0x9f
          }
          0xf0 -> {
            need = 3
            lower = 0x90
          }
          in 0xf1..0xf3 -> need = 3
          0xf4 -> {
            need = 3
            upper = 0x8f
          }
          else -> valid = false
        }
      } else if (b !in lower..upper) {
        valid = false
      } else {
        lower = 0x80
        upper = 0xbf
        need -= 1
      }
    }
  }

  fun finish(): Boolean = valid && need == 0
}
