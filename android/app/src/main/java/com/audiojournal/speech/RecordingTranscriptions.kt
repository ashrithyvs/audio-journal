package com.audiojournal.speech

import ai.hybrid.sdk.HybridAIException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject

/**
 * Final transcription of sealed recordings through the Hybrid AI SDK (AJ
 * ADR-022). Audio Journal supplies the AJR1-backed source and keeps the
 * recording; the SDK owns the model, inference, events, and cancellation.
 *
 * Lifecycle rules (RI-2 §16, `RI-REV-2B`): closing a registration or the
 * client is not cancellation. A cancel or a lock therefore cancels the
 * request first (by cancelling its collector, which cancels the SDK
 * operation and returns only after the operation has reached its single
 * terminal), waits for that within [cancelWaitMs], and only then closes the
 * registration. A failed, cancelled, or interrupted request never touches the
 * recording and yields no transcript.
 *
 * Each job keeps a content-free trace (step names only) for evidence.
 */
class RecordingTranscriptions(
    private val engineFactory: () -> TranscriptionEngine,
    private val openSource: (recordingId: String) -> Ajr1PcmSource,
    private val isCapturing: (recordingId: String) -> Boolean,
    private val deadlineMs: Int = DEADLINE_MS,
    private val cancelWaitMs: Long = CANCEL_WAIT_MS,
    private val clock: () -> Long = { System.nanoTime() / 1_000_000 },
) {
  /** Refused before any SDK work, with a typed code. */
  class Refused(val code: String) : Exception(code)

  class Result(
      val status: String,
      val failure: String?,
      val segments: List<TranscriptionEvents.Segment>,
      val audioMs: Long,
      val totalMs: Long,
      val firstPartialMs: Long,
  ) {
    /** The bridge payload: codes, times, and the validated segments. */
    fun toJson(): JSONObject {
      val list = JSONArray()
      segments.forEach { list.put(JSONObject().put("t0Ms", it.startMs).put("t1Ms", it.endMs).put("text", it.text)) }
      return JSONObject()
          .put("status", status)
          .put("modelId", TranscriptionPins.MODEL_ID)
          .put("segments", list)
          .apply { failure?.let { put("failure", it) } }
          .put(
              "timings",
              JSONObject().put("audioMs", audioMs).put("totalMs", totalMs).put("firstPartialMs", firstPartialMs))
    }
  }

  private class Job(val requestId: String, private val clock: () -> Long) {
    private val started = clock()
    @Volatile var cancelled = false
    var collector: kotlinx.coroutines.Job? = null // guarded by this
    var registration: TranscriptionEngine.Registration? = null // guarded by this
    var source: Ajr1PcmSource? = null
    val done = CountDownLatch(1)
    private val steps = ArrayList<String>()

    fun step(name: String) = synchronized(steps) { steps += "$name@${clock() - started}" }

    fun steps(): List<String> = synchronized(steps) { steps.toList() }

    fun cancel() {
      val running =
          synchronized(this) {
            if (!cancelled) {
              cancelled = true
              step("cancelRequested")
            }
            collector
          }
      running?.cancel()
    }
  }

  private val jobs = LinkedHashMap<String, Job>()
  private val recent = ArrayDeque<JSONObject>()
  private val engineLock = Any()
  private var engine: TranscriptionEngine? = null

  private fun engine(): TranscriptionEngine =
      synchronized(engineLock) { engine ?: engineFactory().also { engine = it } }

  /** Runs one request to its end on the calling thread (a worker, never the UI). */
  fun transcribe(requestId: String, recordingId: String): Result {
    val started = clock()
    val job = Job(requestId, clock)
    synchronized(jobs) {
      if (jobs.containsKey(requestId)) return failed("DUPLICATE_REQUEST", started)
      jobs[requestId] = job
    }
    var firstPartialMs = -1L
    try {
      if (isCapturing(recordingId)) return failed("RECORDING_NOT_SEALED", started)
      val source =
          try {
            openSource(recordingId)
          } catch (refused: Refused) {
            return failed(refused.code, started)
          }
      job.source = source
      if (source.frames <= 0) return failed("EMPTY_RECORDING", started)
      // Refused, never truncated: the recording stays stored and playable.
      if (source.frames > TranscriptionPins.MAX_FRAMES) return failed("UNSUPPORTED_DURATION", started)
      if (job.cancelled) return cancelled(started)
      val engine =
          try {
            engine()
          } catch (_: TranscriptionPack.Invalid) {
            return failed("MODEL_PACK_INVALID", started)
          } catch (error: HybridAIException) {
            return failed(TranscriptionEvents.code(error.code), started)
          }
      val registration =
          try {
            engine.register(source)
          } catch (error: HybridAIException) {
            return failed(TranscriptionEvents.code(error.code), started)
          }
      job.step("registered")
      synchronized(job) {
        job.registration = registration
        if (job.cancelled) return cancelled(started)
      }
      val events = TranscriptionEvents(source.frames)
      var streamFailure: String? = null
      runBlocking {
        val collector =
            launch(start = CoroutineStart.LAZY) {
              try {
                withTimeout(deadlineMs.toLong() + DEADLINE_GRACE_MS) {
                  engine.stream(registration.token, source.frames, requestId, deadlineMs).collect { event ->
                    if (event.type == "partial" && firstPartialMs < 0) firstPartialMs = clock() - started
                    val wasOpen = events.outcome == null
                    if (events.accept(event.type, event.dataJson) && wasOpen) job.step("terminal:${event.type}")
                  }
                }
              } catch (_: TimeoutCancellationException) {
                streamFailure = "TRANSCRIPTION_TIMEOUT"
              } catch (cancel: CancellationException) {
                throw cancel
              } catch (error: HybridAIException) {
                streamFailure = TranscriptionEvents.code(error.code)
              } catch (_: Exception) {
                streamFailure = TranscriptionEvents.FAILED
              }
            }
        val start =
            synchronized(job) {
              job.collector = collector
              !job.cancelled
            }
        if (start) collector.start() else collector.cancel()
        collector.join()
      }
      job.step("collectorEnded")
      if (events.lateEvents > 0) job.step("lateEventsIgnored:${events.lateEvents}")
      if (job.cancelled) return cancelled(started)
      return when (val outcome = events.outcome) {
        is TranscriptionEvents.Outcome.Completed ->
            Result("ok", null, outcome.segments, outcome.audioMs, clock() - started, firstPartialMs)
        is TranscriptionEvents.Outcome.Failed ->
            failed(if (source.damaged) "SOURCE_DAMAGED" else outcome.code, started)
        TranscriptionEvents.Outcome.Cancelled -> cancelled(started)
        null -> failed(streamFailure ?: TranscriptionEvents.PROTOCOL, started)
      }
    } finally {
      // After the request has ended (or never started): revoke the registration,
      // which returns only after the source is closed, then close a source the
      // SDK never took.
      synchronized(job) { job.registration }?.let { registration ->
        registration.close()
        job.step("registrationClosed")
      }
      job.source?.let { source ->
        if (!source.isClosed) source.close()
        job.step("sourceCloses:${source.closeCount}")
      }
      synchronized(jobs) {
        jobs.remove(requestId)
        recent.addLast(trace(job))
        while (recent.size > RECENT_TRACES) recent.removeFirst()
      }
      job.done.countDown()
    }
  }

  /** User cancel. Returns at once; [transcribe] then ends with `cancelled`. */
  fun cancel(requestId: String) {
    synchronized(jobs) { jobs[requestId] }?.cancel()
  }

  /**
   * Vault lock, erase, restore, or teardown: cancel every request, wait (bounded)
   * for each to reach its terminal and release its source, and only then close
   * any registration still open. Returns how many jobs were active.
   */
  fun cancelAll(): Int {
    val active = synchronized(jobs) { jobs.values.toList() }
    active.forEach { it.cancel() }
    val until = clock() + cancelWaitMs
    for (job in active) {
      val ended = job.done.await(maxOf(0L, until - clock()), TimeUnit.MILLISECONDS)
      if (!ended) {
        job.step("cancelWaitExceeded")
        synchronized(job) { job.registration }?.close()
        job.step("registrationClosedAfterWait")
      }
    }
    return active.size
  }

  fun activeCount(): Int = synchronized(jobs) { jobs.size }

  /** Content-free: counts, leases, and recent step traces. */
  fun diagnostics(): JSONObject {
    val leases = synchronized(engineLock) { engine }?.let { runCatching { it.activeLeases() }.getOrDefault(-1) }
    val traces = synchronized(jobs) { JSONArray(recent.toList()) }
    return JSONObject()
        .put("active", activeCount())
        .put("engineOpen", leases != null)
        .put("activeLeases", leases ?: 0)
        .put("recent", traces)
  }

  /** Teardown: cancel first, then close the client. */
  fun close() {
    cancelAll()
    synchronized(engineLock) {
      engine?.close()
      engine = null
    }
  }

  private fun trace(job: Job) = JSONObject().put("requestId", job.requestId).put("steps", JSONArray(job.steps()))

  private fun failed(code: String, started: Long) = Result("failed", code, emptyList(), 0, clock() - started, -1)

  private fun cancelled(started: Long) = Result("cancelled", null, emptyList(), 0, clock() - started, -1)

  companion object {
    /** The SDK's unchanged 120 s computation deadline (AJ-RI-2 plan). */
    const val DEADLINE_MS = 120_000
    private const val DEADLINE_GRACE_MS = 10_000L
    /** Lock waits at most this long for the cancelled request's terminal. */
    const val CANCEL_WAIT_MS = 3_000L
    private const val RECENT_TRACES = 16
  }
}
