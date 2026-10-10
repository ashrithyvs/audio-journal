package com.audiojournal.backup

/**
 * Domain schema v1 records and the manifest (§9.5, §9.6). Mirrors
 * `checkRecord`, `checkRelations`, and `checkManifest` in the reference, with
 * the same rejection reasons. Records are canonical-JSON objects.
 */
object Ajb1Records {
  val TYPES = listOf("entry", "recording", "transcriptSegment")
  private val ID =
      mapOf(
          "entry" to Regex("^ent_[0-9a-hjkmnp-tv-z]{26}$"),
          "recording" to Regex("^rec_[0-9a-hjkmnp-tv-z]{26}$"),
          "transcriptSegment" to Regex("^seg_[0-9a-hjkmnp-tv-z]{26}$"))
  private val MODEL_ID = Regex("^[a-z0-9][a-z0-9._-]{0,63}$")
  private val SHA = Regex("^[0-9a-f]{64}$")

  private class Fields(val required: List<String>, val optional: List<String>)

  private val FIELDS =
      mapOf(
          "entry" to
              Fields(
                  listOf("t", "id", "kind", "status", "createdAtMs", "updatedAtMs"),
                  listOf("title", "sourceText")),
          "recording" to
              Fields(
                  listOf(
                      "t", "id", "entryId", "state", "startedAtMs", "durationMs", "pcmBytes",
                      "pcmSha256"),
                  listOf("endedAtMs", "finishReason")),
          "transcriptSegment" to
              Fields(
                  listOf(
                      "t", "id", "entryId", "recordingId", "engineRevision", "ordinal", "startMs",
                      "endMs", "text", "state", "source", "createdAtMs"),
                  listOf("modelId", "supersedesSegmentId")))

  fun typeIndex(type: String) = TYPES.indexOf(type)

  private fun int(value: Any?) = value as? Long

  private fun str(value: Any?) = value as? String

  /** Field-level checks of one record; a reason, or null when valid. */
  fun check(record: Map<String, Any>, limits: Ajb1.Limits = Ajb1.Limits.V1): String? {
    val type = record["t"] as? String
    val fields = FIELDS[type] ?: return "UNKNOWN_TYPE"
    for (key in record.keys) {
      if (key !in fields.required && key !in fields.optional) return "UNKNOWN_FIELD:$key"
    }
    for (key in fields.required) if (key !in record) return "MISSING_FIELD:$key"
    if (str(record["id"])?.let { ID.getValue(type!!).matches(it) } != true) return "BAD_ID"
    when (type) {
      "entry" -> {
        val kind = record["kind"]
        if (kind != "voice" && kind != "written") return "BAD_KIND"
        if (record["status"] != "ready" && record["status"] != "recovery_required") return "BAD_STATUS"
        val created = int(record["createdAtMs"])
        val updated = int(record["updatedAtMs"])
        if (created == null || updated == null || updated < created) return "BAD_TIME"
        if ("title" in record) {
          val title = str(record["title"])
          if (title == null ||
              title.isEmpty() ||
              title.length > 200 ||
              title != BackupSecrets.collapseWhitespace(title)) {
            return "BAD_TITLE"
          }
        }
        if ((kind == "written") != ("sourceText" in record)) return "BAD_SOURCE"
        if ("sourceText" in record) {
          val source = str(record["sourceText"])
          if (source == null || BackupSecrets.isBlank(source) || source.length > 200_000) {
            return "BAD_SOURCE"
          }
        }
      }
      "recording" -> {
        if (str(record["entryId"])?.let { ID.getValue("entry").matches(it) } != true) {
          return "BAD_REFERENCE"
        }
        val state = record["state"]
        if (state != "ready" && state != "recoverable") return "BAD_STATE"
        val started = int(record["startedAtMs"])
        if (started == null) return "BAD_TIME"
        if ("endedAtMs" in record) {
          val ended = int(record["endedAtMs"])
          if (ended == null || ended < started) return "BAD_TIME"
        }
        if (state == "ready" && ("endedAtMs" !in record || "finishReason" !in record)) {
          return "READY_INCOMPLETE"
        }
        if ("finishReason" in record &&
            record["finishReason"] !in listOf("user", "duration_limit", "storage_low", "recovered")) {
          return "BAD_FINISH_REASON"
        }
        val duration = int(record["durationMs"])
        if (duration == null || duration > limits.maxRecordingDurationMs) return "BAD_DURATION"
        val pcm = int(record["pcmBytes"])
        if (pcm == null ||
            pcm == 0L ||
            pcm % 2 != 0L ||
            pcm > limits.maxRecordingPcmBytes ||
            kotlin.math.abs(pcm - duration * 32) > 32) {
          return "BAD_PCM_BYTES"
        }
        if (str(record["pcmSha256"])?.let { SHA.matches(it) } != true) return "BAD_DIGEST"
      }
      else -> {
        if (str(record["entryId"])?.let { ID.getValue("entry").matches(it) } != true ||
            str(record["recordingId"])?.let { ID.getValue("recording").matches(it) } != true) {
          return "BAD_REFERENCE"
        }
        val numbers =
            listOf("engineRevision", "ordinal", "startMs", "endMs", "createdAtMs").map { int(record[it]) }
        if (numbers.any { it == null }) return "BAD_NUMBER"
        if (numbers[3]!! < numbers[2]!!) return "BAD_RANGE"
        val text = str(record["text"])
        if (text == null || text.length > 4_000) return "BAD_TEXT"
        val state = record["state"]
        if (state != "provisional" && state != "final" && state != "corrected") return "BAD_STATE"
        val source = record["source"]
        if (source != "engine" && source != "user") return "BAD_SOURCE"
        if ((state == "corrected") != (source == "user")) return "BAD_SOURCE"
        if ((state == "corrected") != ("supersedesSegmentId" in record)) return "BAD_SUPERSEDES"
        if ((state == "provisional") != (numbers[0] == 0L)) return "BAD_REVISION"
        if ((state == "final") != ("modelId" in record)) return "BAD_MODEL"
        if ("modelId" in record && str(record["modelId"])?.let { MODEL_ID.matches(it) } != true) {
          return "BAD_MODEL"
        }
        if ("supersedesSegmentId" in record &&
            str(record["supersedesSegmentId"])?.let { ID.getValue("transcriptSegment").matches(it) } !=
                true) {
          return "BAD_SUPERSEDES"
        }
      }
    }
    return null
  }

  /** True when [previous] may precede [next] (by type, then ID byte order). */
  fun inOrder(previous: Map<String, Any>, next: Map<String, Any>): Boolean {
    val a = typeIndex(previous["t"] as String)
    val b = typeIndex(next["t"] as String)
    return a < b || (a == b && (previous["id"] as String) <= (next["id"] as String))
  }

  /** What the cross-record checks keep of a segment. */
  private class Segment(
      val recordingId: String,
      val entryId: String,
      val revision: Long,
      val state: String,
      val endMs: Long,
      val supersedes: String?,
  )

  /**
   * Cross-record checks once every record is read, before any PCM (§9.6).
   * Feed records in order with [add], then call [check].
   */
  class Relations {
    private val entries = HashMap<String, String>() // id -> kind
    val recordings = LinkedHashMap<String, Map<String, Any>>()
    private val segments = LinkedHashMap<String, Segment>()
    val counts = linkedMapOf("entry" to 0L, "recording" to 0L, "transcriptSegment" to 0L)

    fun add(record: Map<String, Any>) {
      val type = record["t"] as String
      val id = record["id"] as String
      counts[type] = counts.getValue(type) + 1
      when (type) {
        "entry" -> entries[id] = record["kind"] as String
        "recording" -> recordings[id] = record
        else ->
            segments[id] =
                Segment(
                    record["recordingId"] as String,
                    record["entryId"] as String,
                    record["engineRevision"] as Long,
                    record["state"] as String,
                    record["endMs"] as Long,
                    record["supersedesSegmentId"] as String?)
      }
    }

    fun check() {
      val recordingOfEntry = HashMap<String, String>()
      for ((id, recording) in recordings) {
        val entryId = recording["entryId"] as String
        if (entries[entryId] != "voice" || entryId in recordingOfEntry) {
          throw Ajb1.Failure("DANGLING_REFERENCE", "records", "recording.entryId")
        }
        recordingOfEntry[entryId] = id
      }
      for ((id, kind) in entries) {
        if (kind == "voice" && id !in recordingOfEntry) {
          throw Ajb1.Failure("DANGLING_REFERENCE", "records", "voice entry without recording")
        }
      }
      val fullPass = HashSet<String>()
      val superseded = HashSet<String>()
      for ((_, segment) in segments) {
        val recording = recordings[segment.recordingId]
        if (recording == null || recording["entryId"] != segment.entryId) {
          throw Ajb1.Failure("DANGLING_REFERENCE", "records", "segment.recordingId")
        }
        if (segment.endMs > recording["durationMs"] as Long) {
          throw Ajb1.Failure("INVALID_RECORD", "records", "segment beyond recording")
        }
        if (segment.revision > 0) fullPass.add(segment.recordingId)
        if (segment.supersedes != null) {
          val target = segments[segment.supersedes]
          if (target == null ||
              target.recordingId != segment.recordingId ||
              target.revision != segment.revision ||
              target.state == "provisional" ||
              segment.supersedes in superseded) {
            throw Ajb1.Failure("DANGLING_REFERENCE", "records", "segment.supersedesSegmentId")
          }
          superseded.add(segment.supersedes)
        }
      }
      for ((_, segment) in segments) {
        if (segment.state == "provisional" && segment.recordingId in fullPass) {
          throw Ajb1.Failure("INVALID_RECORD", "records", "live text beside a full pass")
        }
      }
    }

    val pcmBytes: Long
      get() = recordings.values.sumOf { it["pcmBytes"] as Long }
  }

  fun manifest(
      createdAtMs: Long,
      domainSchemaVersion: Int,
      recordsBytes: Long,
      recordsSha256: String,
      counts: Map<String, Long>,
      pcmBytes: Long,
  ): Map<String, Any> =
      mapOf(
          "createdAtMs" to createdAtMs,
          "domainSchemaVersion" to domainSchemaVersion.toLong(),
          "format" to "AJB1",
          "formatVersion" to Ajb1.FORMAT_VERSION.toLong(),
          "pcm" to mapOf("bytes" to pcmBytes, "recordings" to counts.getValue("recording")),
          "records" to
              mapOf(
                  "bytes" to recordsBytes,
                  "counts" to counts,
                  "lines" to counts.values.sum(),
                  "sha256" to recordsSha256))

  fun checkManifest(value: Any, domainSchemaVersion: Int, limits: Ajb1.Limits) {
    val stage = "manifest"
    fun keys(obj: Any?, expected: Set<String>) = (obj as? Map<*, *>)?.keys == expected
    val manifest = value as? Map<*, *>
    val pcm = manifest?.get("pcm") as? Map<*, *>
    val records = manifest?.get("records") as? Map<*, *>
    val counts = records?.get("counts") as? Map<*, *>
    if (!keys(manifest, setOf("createdAtMs", "domainSchemaVersion", "format", "formatVersion", "pcm", "records")) ||
        !keys(pcm, setOf("bytes", "recordings")) ||
        !keys(records, setOf("bytes", "counts", "lines", "sha256")) ||
        !keys(counts, TYPES.toSet()) ||
        manifest!!["format"] != "AJB1" ||
        manifest["formatVersion"] != Ajb1.FORMAT_VERSION.toLong() ||
        manifest["domainSchemaVersion"] != domainSchemaVersion.toLong() ||
        manifest["createdAtMs"] !is Long ||
        (records!!["sha256"] as? String)?.let { SHA.matches(it) } != true ||
        listOf(pcm!!["bytes"], pcm["recordings"], records["bytes"], records["lines"])
            .plus(counts!!.values)
            .any { it !is Long }) {
      throw Ajb1.Failure("MALFORMED_MANIFEST", stage)
    }
    val count = { type: String -> counts[type] as Long }
    if (count("entry") > limits.maxEntries ||
        count("recording") > limits.maxRecordings ||
        count("transcriptSegment") > limits.maxTranscriptSegments ||
        records["bytes"] as Long > limits.maxRecordsBytes ||
        pcm["bytes"] as Long > limits.maxTotalPcmBytes) {
      throw Ajb1.Failure("LIMIT_EXCEEDED", stage)
    }
    if (pcm["recordings"] != count("recording") ||
        records["lines"] != count("entry") + count("recording") + count("transcriptSegment")) {
      throw Ajb1.Failure("COUNT_MISMATCH", stage)
    }
  }
}
