package com.audiojournal.speech

import org.json.JSONArray
import org.json.JSONObject

/**
 * Checks one `audio.transcribe@1` event stream from the SDK (ADR-027) before
 * anything may be stored. The stream must start with `accepted` and end with
 * exactly one terminal; events after the terminal are counted and ignored. A
 * `completed` result is accepted only if it is contract-valid for this source
 * and names the pinned model; otherwise the outcome is a failure. Text is held
 * in memory only and never logged.
 */
class TranscriptionEvents(private val frames: Long) {
  class Segment(val startMs: Long, val endMs: Long, val text: String)

  sealed class Outcome {
    class Completed(val segments: List<Segment>, val audioMs: Long) : Outcome()

    class Failed(val code: String) : Outcome()

    object Cancelled : Outcome()
  }

  var outcome: Outcome? = null
    private set

  /** Events received after the terminal (ignored; nonzero means an SDK contract breach). */
  var lateEvents = 0
    private set

  var partials = 0
    private set

  private var accepted = false
  private val streamed = ArrayList<String>()

  /** Applies one event; returns true once the terminal has been seen. */
  fun accept(type: String, dataJson: String): Boolean {
    if (outcome != null) {
      lateEvents += 1
      return true
    }
    if (!accepted) {
      if (type == "accepted") {
        accepted = true
        return false
      }
      // Only a terminal may arrive without `accepted` (refused before admission).
      if (type !in TERMINALS) return finish(Outcome.Failed(PROTOCOL))
    }
    val result =
        try {
          when (type) {
            "partial" -> {
              partial(JSONObject(dataJson))
              null
            }
            "completed" -> completed(JSONObject(dataJson))
            "failed" -> Outcome.Failed(code(JSONObject(dataJson).optString("code")))
            "cancelled" -> Outcome.Cancelled
            "accepted" -> Outcome.Failed(PROTOCOL)
            else -> null // progress and future non-terminal types carry nothing to store
          }
        } catch (_: Exception) {
          Outcome.Failed(PROTOCOL)
        }
    return if (result != null) finish(result) else false
  }

  private fun finish(result: Outcome): Boolean {
    outcome = result
    return true
  }

  private fun partial(data: JSONObject) {
    val segments = data.getJSONObject("delta").getJSONArray("segments")
    partials += 1
    for (i in 0 until segments.length()) streamed += segments.getJSONObject(i).toString()
    if (streamed.size > MAX_SEGMENTS) throw IllegalStateException(PROTOCOL)
  }

  private fun completed(data: JSONObject): Outcome {
    val output = data.getJSONObject("output")
    val audioMs = output.getLong("audioMs")
    val model = output.getJSONObject("model")
    val list = output.getJSONArray("segments")
    val valid =
        audioMs == frames * 1_000 / TranscriptionPins.SAMPLE_RATE &&
            audioMs in 1..TranscriptionPins.MAX_AUDIO_MS &&
            model.getString("profileId") == TranscriptionPins.PROFILE_ID &&
            model.getString("profileVersion") == TranscriptionPins.PROFILE_VERSION &&
            model.getString("artifactSha256") == TranscriptionPins.MODEL_SHA256 &&
            list.length() <= MAX_SEGMENTS &&
            // The final segments are exactly the delivered partials, in order.
            (0 until list.length()).map { list.getJSONObject(it).toString() } == streamed
    if (!valid) return Outcome.Failed(INVALID_RESULT)
    val segments = segments(list, audioMs) ?: return Outcome.Failed(INVALID_RESULT)
    return Outcome.Completed(segments, audioMs)
  }

  /** Contiguous indexes, ordered non-overlapping spans inside the audio, non-empty text. */
  private fun segments(list: JSONArray, audioMs: Long): List<Segment>? {
    val out = ArrayList<Segment>(list.length())
    var previousEnd = 0L
    for (i in 0 until list.length()) {
      val segment = list.getJSONObject(i)
      val start = segment.getLong("startMs")
      val end = segment.getLong("endMs")
      val text = segment.getString("text")
      if (segment.getInt("index") != i || start < previousEnd || end < start || end > audioMs) return null
      if (text.isEmpty() || text.length > MAX_TEXT) return null
      out += Segment(start, end, text)
      previousEnd = end
    }
    return out
  }

  companion object {
    val TERMINALS = setOf("completed", "failed", "cancelled")
    const val PROTOCOL = "TRANSCRIPTION_PROTOCOL"
    const val INVALID_RESULT = "INVALID_RESULT"
    const val FAILED = "TRANSCRIPTION_FAILED"
    private const val MAX_SEGMENTS = 2_048
    private const val MAX_TEXT = 1_024
    private val CODE = Regex("^[A-Z][A-Z0-9_]{2,40}$")

    /** SDK error codes are typed constants; anything else becomes a generic code. */
    fun code(value: String?): String = if (value != null && CODE.matches(value)) value else FAILED
  }
}
