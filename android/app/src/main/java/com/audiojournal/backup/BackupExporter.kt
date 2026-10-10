package com.audiojournal.backup

import com.audiojournal.vault.KdfParams
import com.audiojournal.vault.VaultCrypto
import java.io.OutputStream
import java.nio.ByteBuffer
import java.security.MessageDigest
import javax.crypto.AEADBadTagException

/** A recording row eligible for export (§9.6), from one read snapshot. */
class SnapshotRecording(
    val id: String,
    val entryId: String,
    val state: String,
    val startedAtMs: Long,
    val endedAtMs: Long?,
    val durationMs: Long,
    val finishReason: String?,
    /** The stored digest of a ready recording; recoverable ones are hashed. */
    val contentSha256: String?,
)

/**
 * One consistent read of the journal (§9.10 export step 1). Entries and
 * segments are delivered as canonical records in ID order; the same snapshot
 * must deliver the same records on every pass.
 */
interface JournalSnapshot {
  fun recordings(): List<SnapshotRecording>

  fun forEachEntry(exclude: Set<String>, visit: (Map<String, Any>) -> Unit)

  fun forEachSegment(exclude: Set<String>, visit: (Map<String, Any>) -> Unit)
}

/** Decrypted PCM of AJR1 recordings, streamed natively. */
interface RecordingPcm {
  /** PCM bytes in a ready recording's frames (authenticated when streamed). */
  fun pcmBytes(recordingId: String): Long

  /** Length and SHA-256 of a recoverable recording's authenticated prefix. */
  fun authenticatedPrefix(recordingId: String): Pair<Long, String>

  /** Streams `[0, pcmBytes)`; throws [AEADBadTagException] on damage. */
  fun stream(recordingId: String, pcmBytes: Long, onPcm: (ByteArray, Int, Int) -> Unit)
}

/**
 * AJB1 export (§9.10): pass 1 plans and validates everything before any KDF
 * work; pass 2 streams the sections through the segment sealer. Plaintext is
 * held only in bounded buffers. A recording that cannot be read in full stops
 * the export with the affected entries listed (owner decision 2026-10-10);
 * it is left out only when the caller passes its entry in [exclude].
 */
class BackupExporter(
    private val snapshot: JournalSnapshot,
    private val pcm: RecordingPcm,
    private val limits: Ajb1.Limits = Ajb1.Limits.V1,
    private val checkpoint: (String) -> Unit = {},
) {
  /** Recordings that could not be read in full: entry and recording IDs. */
  class Damaged(val entries: List<Pair<String, String>>) : Exception("SOURCE_DAMAGED")

  class Plan(
      val exclude: Set<String>,
      val recordings: List<Map<String, Any>>,
      val recordsBytes: Long,
      val recordsSha256: String,
      val counts: Map<String, Long>,
      val pcmBytes: Long,
      val manifest: ByteArray,
      /** Plaintext stream length, and the archive length it seals to. */
      val plaintextBytes: Long,
      val archiveBytes: Long,
  )

  /** Pass 1. Throws [Damaged], or [Ajb1.Failure] with `LIMIT_EXCEEDED`. */
  fun plan(createdAtMs: Long, exclude: Set<String> = emptySet()): Plan {
    val damaged = ArrayList<Pair<String, String>>()
    val recordings = ArrayList<Map<String, Any>>()
    for (row in snapshot.recordings().sortedBy { it.id }) {
      if (row.entryId in exclude) continue
      val (bytes, digest) =
          try {
            if (row.state == "ready") {
              pcm.pcmBytes(row.id) to (row.contentSha256 ?: throw AEADBadTagException())
            } else {
              pcm.authenticatedPrefix(row.id)
            }
          } catch (_: Exception) {
            damaged.add(row.entryId to row.id)
            continue
          }
      recordings.add(recordRecording(row, bytes, digest))
    }
    if (damaged.isNotEmpty()) throw Damaged(damaged)
    checkpoint("planned-recordings")

    val relations = Ajb1Records.Relations()
    val digest = MessageDigest.getInstance("SHA-256")
    var recordsBytes = 0L
    forEachRecord(exclude, recordings) { record ->
      Ajb1Records.check(record, limits)?.let { throw Ajb1.Failure("INVALID_RECORD", "export", it) }
      val line = (CanonicalJson.serialize(record) + "\n").toByteArray(Charsets.UTF_8)
      if (line.size - 1 > limits.maxLineBytes) throw Ajb1.Failure("LIMIT_EXCEEDED", "export", "line")
      digest.update(line)
      recordsBytes += line.size
      relations.add(record)
    }
    relations.check()
    val counts = relations.counts
    val pcmBytes = relations.pcmBytes
    if (counts.getValue("entry") > limits.maxEntries ||
        counts.getValue("recording") > limits.maxRecordings ||
        counts.getValue("transcriptSegment") > limits.maxTranscriptSegments ||
        recordsBytes > limits.maxRecordsBytes ||
        pcmBytes > limits.maxTotalPcmBytes) {
      throw Ajb1.Failure("LIMIT_EXCEEDED", "export")
    }
    val sha = Ajb1.hex(digest.digest())
    val manifest =
        CanonicalJson.serialize(
                Ajb1Records.manifest(createdAtMs, Ajb1.DOMAIN_SCHEMA_VERSION, recordsBytes, sha, counts, pcmBytes))
            .toByteArray(Charsets.UTF_8)
    val sections = 3L + recordings.size
    val plaintext =
        sections * Ajb1.SECTION_HEADER_BYTES + manifest.size + recordsBytes +
            recordings.size * Ajb1.ID_BYTES.toLong() + pcmBytes
    val segments = plaintext / Ajb1.SEGMENT_BYTES + 1
    val archive = Ajb1.HEADER_BYTES + plaintext + segments * Ajb1.TAG_BYTES
    if (archive > limits.maxArchiveBytes) throw Ajb1.Failure("LIMIT_EXCEEDED", "export", "archive size")
    checkpoint("planned")
    return Plan(exclude, recordings, recordsBytes, sha, counts, pcmBytes, manifest, plaintext, archive)
  }

  private fun recordRecording(row: SnapshotRecording, pcmBytes: Long, sha: String): Map<String, Any> {
    val record =
        linkedMapOf<String, Any>(
            "t" to "recording",
            "id" to row.id,
            "entryId" to row.entryId,
            "state" to row.state,
            "startedAtMs" to row.startedAtMs,
            "durationMs" to row.durationMs,
            "pcmBytes" to pcmBytes,
            "pcmSha256" to sha)
    row.endedAtMs?.let { record["endedAtMs"] = it }
    row.finishReason?.let { record["finishReason"] = it }
    return record
  }

  /** Canonical order (§9.6): entries, recordings, then segments, each by ID. */
  private fun forEachRecord(
      exclude: Set<String>,
      recordings: List<Map<String, Any>>,
      visit: (Map<String, Any>) -> Unit,
  ) {
    snapshot.forEachEntry(exclude, visit)
    recordings.forEach(visit)
    snapshot.forEachSegment(exclude, visit)
  }

  /**
   * Pass 2: writes the archive for [plan] to [out]. The records are
   * re-serialized from the same snapshot and must hash to the plan's digest.
   */
  fun write(
      plan: Plan,
      out: OutputStream,
      kdf: KdfParams,
      secretKind: Int,
      kek: ByteArray,
      random: (Int) -> ByteArray = VaultCrypto::randomBytes,
  ) {
    val dek = random(32)
    val noncePrefix = random(4)
    try {
      val header =
          Ajb1.buildHeader(
              kdf, random(16).also { require(it.size == 16) }, secretKind, Ajb1.DOMAIN_SCHEMA_VERSION,
              noncePrefix, random(12), kek, dek)
      val writer = SegmentWriter(out, header, dek, noncePrefix)
      fun section(kind: Int, length: Long) {
        writer.write(
            ByteBuffer.allocate(Ajb1.SECTION_HEADER_BYTES).put(kind.toByte()).put(ByteArray(3)).putLong(length).array())
      }
      section(Ajb1.SECTION_MANIFEST, plan.manifest.size.toLong())
      writer.write(plan.manifest)
      section(Ajb1.SECTION_RECORDS, plan.recordsBytes)
      val digest = MessageDigest.getInstance("SHA-256")
      var written = 0L
      forEachRecord(plan.exclude, plan.recordings) { record ->
        val line = (CanonicalJson.serialize(record) + "\n").toByteArray(Charsets.UTF_8)
        digest.update(line)
        writer.write(line)
        written += line.size
      }
      if (written != plan.recordsBytes || Ajb1.hex(digest.digest()) != plan.recordsSha256) {
        throw Ajb1.Failure("SNAPSHOT_CHANGED", "export")
      }
      checkpoint("records")
      for (recording in plan.recordings) {
        val id = recording["id"] as String
        val bytes = recording["pcmBytes"] as Long
        section(Ajb1.SECTION_RECORDING, Ajb1.ID_BYTES + bytes)
        writer.write(id.toByteArray(Charsets.US_ASCII))
        val hash = MessageDigest.getInstance("SHA-256")
        var streamed = 0L
        try {
          pcm.stream(id, bytes) { buffer, offset, length ->
            hash.update(buffer, offset, length)
            writer.write(buffer, offset, length)
            streamed += length
          }
        } catch (_: AEADBadTagException) {
          throw Damaged(listOf((recording["entryId"] as String) to id))
        }
        if (streamed != bytes || Ajb1.hex(hash.digest()) != recording["pcmSha256"]) {
          throw Damaged(listOf((recording["entryId"] as String) to id))
        }
        checkpoint("recording")
      }
      section(Ajb1.SECTION_END, 0)
      writer.finish()
    } finally {
      VaultCrypto.zero(dek)
    }
  }
}
