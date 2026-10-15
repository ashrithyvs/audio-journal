package com.audiojournal.speech

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The SDK event stream is checked before anything may be stored (ADR-027). */
class TranscriptionEventsTest {
  private val frames = 48_000L // 3,000 ms

  companion object {
    fun segment(index: Int, start: Long, end: Long, text: String) =
        JSONObject().put("index", index).put("startMs", start).put("endMs", end).put("text", text)

    fun partial(vararg segments: JSONObject) =
        JSONObject().put("delta", JSONObject().put("segments", JSONArray(segments.toList()))).toString()

    fun completed(
        segments: List<JSONObject>,
        audioMs: Long = 3_000,
        profileId: String = TranscriptionPins.PROFILE_ID,
        artifact: String = TranscriptionPins.MODEL_SHA256,
    ) =
        JSONObject()
            .put(
                "output",
                JSONObject()
                    .put("segments", JSONArray(segments))
                    .put("audioMs", audioMs)
                    .put(
                        "model",
                        JSONObject()
                            .put("profileId", profileId)
                            .put("profileVersion", TranscriptionPins.PROFILE_VERSION)
                            .put("artifactSha256", artifact)))
            .toString()
  }

  private val a = segment(0, 0, 1_000, " hello")
  private val b = segment(1, 1_000, 2_500, " there")

  private fun run(vararg events: Pair<String, String>): TranscriptionEvents =
      TranscriptionEvents(frames).also { checker -> events.forEach { checker.accept(it.first, it.second) } }

  @Test
  fun aContractValidCompletionIsAccepted() {
    val checker =
        run("accepted" to "{}", "partial" to partial(a), "partial" to partial(b), "completed" to completed(listOf(a, b)))
    val outcome = checker.outcome as TranscriptionEvents.Outcome.Completed
    assertEquals(listOf(" hello", " there"), outcome.segments.map { it.text })
    assertEquals(3_000, outcome.audioMs)
    assertEquals(2, checker.partials)
  }

  @Test
  fun exactlyOneTerminalCountsAndLaterEventsAreIgnored() {
    val checker = TranscriptionEvents(frames)
    assertFalse(checker.accept("accepted", "{}"))
    assertTrue(checker.accept("cancelled", "{}"))
    assertTrue(checker.accept("completed", completed(emptyList())))
    assertTrue(checker.accept("partial", partial(a)))
    assertEquals(TranscriptionEvents.Outcome.Cancelled, checker.outcome)
    assertEquals(2, checker.lateEvents)
  }

  @Test
  fun everyContractBreachIsAFailureNotATranscript() {
    val breaches =
        listOf(
            // no accepted first
            arrayOf("partial" to partial(a)),
            // a second accepted
            arrayOf("accepted" to "{}", "accepted" to "{}"),
            // wrong model, wrong artifact, wrong audio length
            arrayOf("accepted" to "{}", "partial" to partial(a), "completed" to completed(listOf(a), profileId = "other")),
            arrayOf("accepted" to "{}", "partial" to partial(a), "completed" to completed(listOf(a), artifact = "0".repeat(64))),
            arrayOf("accepted" to "{}", "partial" to partial(a), "completed" to completed(listOf(a), audioMs = 2_999)),
            // final differs from the delivered partials
            arrayOf("accepted" to "{}", "partial" to partial(a), "completed" to completed(listOf(a, b))),
            // out of order, out of bounds, empty text, bad index
            arrayOf(
                "accepted" to "{}",
                "partial" to partial(segment(0, 1_000, 1_500, "x"), segment(1, 0, 500, "y")),
                "completed" to completed(listOf(segment(0, 1_000, 1_500, "x"), segment(1, 0, 500, "y")))),
            arrayOf("accepted" to "{}", "partial" to partial(segment(0, 0, 3_001, "x")), "completed" to completed(listOf(segment(0, 0, 3_001, "x")))),
            arrayOf("accepted" to "{}", "partial" to partial(segment(0, 0, 10, "")), "completed" to completed(listOf(segment(0, 0, 10, "")))),
            arrayOf("accepted" to "{}", "partial" to partial(segment(3, 0, 10, "x")), "completed" to completed(listOf(segment(3, 0, 10, "x")))),
            // malformed JSON
            arrayOf("accepted" to "{}", "partial" to "{not json"),
        )
    for (events in breaches) {
      val outcome = run(*events).outcome
      assertTrue("${events.map { it.first }} -> $outcome", outcome is TranscriptionEvents.Outcome.Failed)
    }
  }

  @Test
  fun failureCodesAreTypedConstantsOnly() {
    val typed = run("accepted" to "{}", "failed" to JSONObject().put("code", "DEADLINE_EXCEEDED").toString())
    assertEquals("DEADLINE_EXCEEDED", (typed.outcome as TranscriptionEvents.Outcome.Failed).code)
    val unsafe = run("failed" to JSONObject().put("code", "/data/user/0 secret").toString())
    assertEquals("TRANSCRIPTION_FAILED", (unsafe.outcome as TranscriptionEvents.Outcome.Failed).code)
  }

  @Test
  fun progressAndUnknownNonTerminalEventsCarryNothing() {
    val checker =
        run("accepted" to "{}", "progress" to "{}", "partial" to partial(a), "completed" to completed(listOf(a)))
    assertTrue(checker.outcome is TranscriptionEvents.Outcome.Completed)
  }
}
