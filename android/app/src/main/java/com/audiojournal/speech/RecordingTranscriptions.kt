package com.audiojournal.speech

import ai.hybrid.sdk.HybridAIException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONArray
import org.json.JSONObject

/**
 * Final transcription of sealed recordings through the Hybrid AI SDK (AJ
 * ADR-022). Audio Journal supplies the AJR1-backed source and keeps the
 * recording; the SDK owns the model, inference, events, and cancellation.
 *
 * Lifecycle rules (RI-2 §16, `RI-REV-2B`): closing a registration or the
 * client is not cancellation. A cancel or a lock therefore cancels the SDK
 * operation, keeps pulling until that operation's single terminal arrives,
 * waits for its producer to return and its model lease to be released (all
 * within [cancelWaitMs]), and only then closes the registration. A failed,
 * cancelled, or interrupted request never touches the recording and yields no
 * transcript. After a lock, no new request starts until the vault has been
 * unlocked again ([unlockEpoch]).
 *
 * Each job keeps a content-free trace (step names and times) for evidence.
 */
class RecordingTranscriptions(
    private val engineFactory: () -> TranscriptionEngine,
    private val openSource: (recordingId: String) -> Ajr1PcmSource,
    private val isCapturing: (recordingId: String) -> Boolean,
    /** Increases with every vault unlock; requests are refused at or below a lock's epoch. */
    private val unlockEpoch: () -> Long = { 0L },
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
    var execution: TranscriptionEngine.Execution? = null // guarded by this
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
            execution
          }
      // The operation ends with its own terminal, which the worker still pulls.
      running?.cancel()
    }
  }

  private val jobs = LinkedHashMap<String, Job>()
  /** Cancels that arrived before their request started (bounded). */
  private val cancelledEarly = LinkedHashSet<String>()
  /** The vault epoch at the last lock; requests need a later unlock. */
  private var lockedAtEpoch = -1L
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
      if (unlockEpoch() <= lockedAtEpoch) return failed("LOCKED", started)
      if (cancelledEarly.remove(requestId)) return cancelled(started)
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
      synchronized(job) { job.registration = registration }
      job.step("registered")
      if (job.cancelled) return cancelled(started)
      val execution =
          try {
            engine.prepare(registration.token, source.frames, requestId, deadlineMs)
          } catch (error: HybridAIException) {
            return failed(TranscriptionEvents.code(error.code), started)
          }
      val events = TranscriptionEvents(source.frames)
      var pullFailure: String? = null
      execution.use {
        synchronized(job) {
          job.execution = execution
          if (job.cancelled) execution.cancel()
        }
        val producerFailed = AtomicBoolean(false)
        val producer =
            Thread(
                {
                  try {
                    execution.run()
                  } catch (_: Throwable) {
                    producerFailed.set(true)
                  }
                },
                "aj-transcription-producer")
        producer.start()
        val watchdog = started + deadlineMs + DEADLINE_GRACE_MS
        var watchdogCancelledAt = -1L
        while (true) {
          when (val pulled = execution.next(POLL_MS)) {
            is TranscriptionEngine.Pulled.Event -> {
              if (pulled.type == "partial" && firstPartialMs < 0) firstPartialMs = clock() - started
              val wasOpen = events.outcome == null
              if (events.accept(pulled.type, pulled.dataJson) && wasOpen) job.step("terminal:${pulled.type}")
            }
            TranscriptionEngine.Pulled.End -> break
            TranscriptionEngine.Pulled.Timeout -> {
              if (producerFailed.get() && !producer.isAlive) {
                pullFailure = TranscriptionEvents.FAILED
                break
              }
              val now = clock()
              if (watchdogCancelledAt < 0 && now > watchdog) {
                // The SDK enforces the deadline; this only guards a stuck stream.
                pullFailure = "TRANSCRIPTION_TIMEOUT"
                watchdogCancelledAt = now
                job.step("watchdogCancel")
                execution.cancel()
              } else if (watchdogCancelledAt >= 0 && now - watchdogCancelledAt > cancelWaitMs) {
                break
              }
            }
          }
        }
        execution.cancel() // no-op after the terminal; releases an abandoned producer
        producer.join(cancelWaitMs)
        job.step(if (producer.isAlive) "producerJoinExceeded" else "producerEnded")
      }
      // Inference has left the model before the source registration is closed.
      awaitLeaseRelease(engine, job)
      if (events.lateEvents > 0) job.step("lateEventsIgnored:${events.lateEvents}")
      if (job.cancelled) return cancelled(started)
      return when (val outcome = events.outcome) {
        is TranscriptionEvents.Outcome.Completed ->
            Result("ok", null, outcome.segments, outcome.audioMs, clock() - started, firstPartialMs)
        is TranscriptionEvents.Outcome.Failed ->
            failed(if (source.damaged) "SOURCE_DAMAGED" else outcome.code, started)
        TranscriptionEvents.Outcome.Cancelled -> cancelled(started)
        null -> failed(pullFailure ?: TranscriptionEvents.PROTOCOL, started)
      }
    } finally {
      val registration = synchronized(job) { job.registration }
      if (registration != null) {
        // The SDK owns the source once registered: revoking returns only after its close.
        registration.close()
        job.step("registrationClosed")
      } else {
        job.source?.let { if (!it.isClosed) it.close() }
      }
      job.source?.let { job.step("sourceCloses:${it.closeCount}") }
      synchronized(jobs) {
        jobs.remove(requestId)
        recent.addLast(trace(job))
        while (recent.size > RECENT_TRACES) recent.removeFirst()
      }
      job.done.countDown()
    }
  }

  private fun awaitLeaseRelease(engine: TranscriptionEngine, job: Job) {
    val until = clock() + cancelWaitMs
    while (true) {
      val leases = runCatching { engine.activeLeases() }.getOrDefault(-1)
      if (leases == 0) {
        job.step("leaseReleased")
        return
      }
      if (leases < 0 || clock() >= until) {
        job.step("leaseWaitExceeded")
        return
      }
      Thread.sleep(LEASE_POLL_MS)
    }
  }

  /**
   * User cancel. Returns at once; [transcribe] then ends with `cancelled`. A
   * cancel that arrives before its request has started is remembered.
   */
  fun cancel(requestId: String) {
    val job =
        synchronized(jobs) {
          val running = jobs[requestId]
          if (running == null) {
            cancelledEarly += requestId
            while (cancelledEarly.size > EARLY_CANCELS) cancelledEarly.remove(cancelledEarly.first())
          }
          running
        }
    job?.cancel()
  }

  /**
   * Vault lock, erase, restore, or teardown: refuse new requests until the
   * next unlock, cancel every running request, and wait (bounded) for each to
   * reach its terminal, release its model lease, and close its registration.
   * Anything still open after the bound is closed here. Returns how many jobs
   * were active.
   */
  fun cancelAll(): Int {
    val active =
        synchronized(jobs) {
          lockedAtEpoch = unlockEpoch()
          jobs.values.toList()
        }
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
    /** A cancel or lock waits at most this long for terminal, producer, and lease. */
    const val CANCEL_WAIT_MS = 3_000L
    private const val POLL_MS = 100
    private const val LEASE_POLL_MS = 5L
    private const val RECENT_TRACES = 16
    private const val EARLY_CANCELS = 32
  }
}
