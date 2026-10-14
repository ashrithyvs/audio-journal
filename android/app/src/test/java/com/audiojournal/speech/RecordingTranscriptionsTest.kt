package com.audiojournal.speech

import ai.hybrid.sdk.ExecutionEvent
import ai.hybrid.sdk.HybridAIException
import ai.hybrid.sdk.PcmAudioSource
import java.io.File
import java.nio.file.Files
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Lifecycle orderings of [RecordingTranscriptions] against a scripted engine
 * that behaves like the SDK (one terminal; the request's end closes the
 * source; registration close waits for the source close). The real SDK runs
 * the same paths on device (`TranscriptionDurabilityDeviceTest`).
 */
class RecordingTranscriptionsTest {
  private lateinit var dir: File
  private val pool = Executors.newCachedThreadPool()

  @Before
  fun setUp() {
    dir = Files.createTempDirectory("aj-ri2-jobs").toFile()
  }

  @After
  fun tearDown() {
    pool.shutdownNow()
    dir.deleteRecursively()
  }

  /** What the scripted request does after `accepted` and one partial. */
  enum class Script { COMPLETE, FAIL, FAIL_ON_READ, HANG_UNTIL_CANCELLED, IGNORE_CANCEL, LATE_EVENTS }

  inner class FakeEngine(var script: Script) : TranscriptionEngine {
    val log: MutableList<String> = Collections.synchronizedList(mutableListOf())
    val started = CountDownLatch(1)
    val leases = AtomicInteger()
    var sources = mutableListOf<PcmAudioSource>()
    var refuseRegistration: String? = null

    override fun register(source: PcmAudioSource): TranscriptionEngine.Registration {
      refuseRegistration?.let { throw HybridAIException(it, it) }
      sources += source
      log += "register"
      var open = true
      return object : TranscriptionEngine.Registration {
        override val token = "0".repeat(32)

        override fun close() {
          synchronized(this) {
            if (!open) return
            open = false
          }
          // Revocation closes a source the request did not already close.
          if (!(source as Ajr1PcmSource).isClosed) source.close()
          log += "registrationClose"
        }
      }
    }

    override fun stream(token: String, frames: Long, requestId: String, deadlineMs: Int): Flow<ExecutionEvent> = flow {
      val source = sources.last()
      leases.incrementAndGet()
      var terminal = "none"
      try {
        emit(event("accepted", "{}"))
        val seg = TranscriptionEventsTest.segment(0, 0, frames * 1_000 / 16_000, "words")
        emit(event("partial", TranscriptionEventsTest.partial(seg)))
        started.countDown()
        when (script) {
          Script.COMPLETE -> {
            emit(event("completed", TranscriptionEventsTest.completed(listOf(seg), frames * 1_000 / 16_000)))
            terminal = "completed"
          }
          Script.LATE_EVENTS -> {
            emit(event("completed", TranscriptionEventsTest.completed(listOf(seg), frames * 1_000 / 16_000)))
            emit(event("partial", TranscriptionEventsTest.partial(seg)))
            emit(event("cancelled", "{}"))
            terminal = "completed"
          }
          Script.FAIL -> {
            emit(event("failed", JSONObject().put("code", "MODEL_UNAVAILABLE").toString()))
            terminal = "failed"
          }
          Script.FAIL_ON_READ -> {
            val read = source.read(16_000, java.nio.ShortBuffer.allocate(16_000))
            emit(event("failed", JSONObject().put("code", "SOURCE_READ_FAILED").put("read", read.status.name).toString()))
            terminal = "failed"
          }
          Script.HANG_UNTIL_CANCELLED -> awaitCancellation()
          Script.IGNORE_CANCEL -> {
            Thread.sleep(1_500) // non-cooperative compute
            emit(event("completed", TranscriptionEventsTest.completed(listOf(seg), frames * 1_000 / 16_000)))
            terminal = "completed"
          }
        }
      } finally {
        // The operation's single terminal; then the SDK closes the claimed source.
        log += "operationEnded:${if (terminal == "none") "cancelled" else terminal}"
        if (!(source as Ajr1PcmSource).isClosed) source.close()
        leases.decrementAndGet()
      }
    }

    override fun activeLeases() = leases.get()

    override fun close() {
      log += "engineClose"
    }

    private fun event(type: String, data: String) = ExecutionEvent(0, type, "r", data)
  }

  private fun service(
      engine: () -> TranscriptionEngine,
      seconds: Int = 3,
      capturing: Boolean = false,
      cancelWaitMs: Long = 3_000,
  ): Pair<RecordingTranscriptions, () -> Ajr1PcmSource> {
    val file = TestRecordings.write(dir, TestRecordings.samples(seconds * 16_000))
    var last: Ajr1PcmSource? = null
    val transcriptions =
        RecordingTranscriptions(
            engineFactory = engine,
            openSource = { TestRecordings.open(file).also { last = it } },
            isCapturing = { capturing },
            cancelWaitMs = cancelWaitMs,
        )
    return transcriptions to { last!! }
  }

  private fun RecordingTranscriptions.async(id: String): Future<RecordingTranscriptions.Result> =
      pool.submit<RecordingTranscriptions.Result> { transcribe(id, TestRecordings.ID) }

  private fun steps(t: RecordingTranscriptions): List<String> {
    val recent = t.diagnostics().getJSONArray("recent")
    val steps = recent.getJSONObject(recent.length() - 1).getJSONArray("steps")
    return (0 until steps.length()).map { steps.getString(it).substringBefore('@') }
  }

  @Test
  fun completesAndReleasesEverything() {
    val engine = FakeEngine(Script.COMPLETE)
    val (t, source) = service({ engine })
    val result = t.transcribe("r1", TestRecordings.ID)
    assertEquals("ok", result.status)
    assertEquals(listOf("words"), result.segments.map { it.text })
    assertEquals(TranscriptionPins.MODEL_ID, result.toJson().getString("modelId"))
    assertEquals(1, source().closeCount)
    assertEquals(0, t.activeCount())
    assertEquals(0, engine.activeLeases())
    assertEquals(listOf("registered", "terminal:completed", "collectorEnded", "registrationClosed", "sourceCloses:1"), steps(t))
  }

  @Test
  fun userCancelEndsTheOperationBeforeTheRegistrationCloses() {
    val engine = FakeEngine(Script.HANG_UNTIL_CANCELLED)
    val (t, source) = service({ engine })
    val pending = t.async("r1")
    assertTrue(engine.started.await(5, TimeUnit.SECONDS))
    t.cancel("r1")
    val result = pending.get(5, TimeUnit.SECONDS)
    assertEquals("cancelled", result.status)
    assertTrue(result.segments.isEmpty())
    assertEquals(listOf("register", "operationEnded:cancelled", "registrationClose"), engine.log)
    assertEquals(1, source().closeCount)
    assertEquals(0, engine.activeLeases())
    assertEquals(0, t.activeCount())
  }

  @Test
  fun lockCancelsWaitsForTheTerminalThenCloses() {
    val engine = FakeEngine(Script.HANG_UNTIL_CANCELLED)
    val (t, source) = service({ engine })
    val pending = t.async("r1")
    assertTrue(engine.started.await(5, TimeUnit.SECONDS))
    assertEquals(1, t.cancelAll())
    // cancelAll returned only after the request had ended and been released.
    assertEquals(listOf("register", "operationEnded:cancelled", "registrationClose"), engine.log)
    assertEquals(1, source().closeCount)
    assertEquals(0, t.activeCount())
    assertEquals("cancelled", pending.get(5, TimeUnit.SECONDS).status)
    val order = steps(t)
    assertTrue(order.toString(), order.indexOf("cancelRequested") < order.indexOf("collectorEnded"))
    assertTrue(order.toString(), order.indexOf("collectorEnded") < order.indexOf("registrationClosed"))
    // The client survives the lock; the next request works.
    engine.script = Script.COMPLETE
    assertEquals("ok", t.transcribe("r2", TestRecordings.ID).status)
  }

  @Test
  fun aLockThatOutlastsTheBoundClosesTheRegistrationAndStoresNothing() {
    val engine = FakeEngine(Script.IGNORE_CANCEL)
    val (t, source) = service({ engine }, cancelWaitMs = 200)
    val pending = t.async("r1")
    assertTrue(engine.started.await(5, TimeUnit.SECONDS))
    t.cancelAll()
    assertTrue(source().isClosed)
    val result = pending.get(10, TimeUnit.SECONDS)
    assertEquals("a cancelled request never yields a transcript", "cancelled", result.status)
    assertTrue(steps(t).contains("cancelWaitExceeded"))
    assertEquals(1, source().closeCount)
  }

  @Test
  fun providerFailureLeavesNothingAndARetrySucceeds() {
    val engine = FakeEngine(Script.FAIL)
    val (t, _) = service({ engine })
    val failed = t.transcribe("r1", TestRecordings.ID)
    assertEquals("failed", failed.status)
    assertEquals("MODEL_UNAVAILABLE", failed.failure)
    assertTrue(failed.segments.isEmpty())
    engine.script = Script.COMPLETE
    assertEquals("ok", t.transcribe("r2", TestRecordings.ID).status)
  }

  @Test
  fun aDamagedRecordingIsReportedAsSuch() {
    val engine = FakeEngine(Script.FAIL_ON_READ)
    val file = TestRecordings.write(dir, TestRecordings.samples(3 * 16_000))
    java.io.RandomAccessFile(file, "rw").use { raf ->
      val at = (com.audiojournal.recording.Ajr1.HEADER_BYTES + 2 * 12 + 32_000 + 16 + 20).toLong()
      raf.seek(at)
      val byte = raf.read()
      raf.seek(at)
      raf.write(byte xor 1)
    }
    val t = RecordingTranscriptions({ engine }, { TestRecordings.open(file) }, { false })
    assertEquals("SOURCE_DAMAGED", t.transcribe("r1", TestRecordings.ID).failure)
  }

  @Test
  fun eventsAfterTheTerminalAreIgnored() {
    val engine = FakeEngine(Script.LATE_EVENTS)
    val (t, _) = service({ engine })
    assertEquals("ok", t.transcribe("r1", TestRecordings.ID).status)
    assertTrue(steps(t).contains("lateEventsIgnored:2"))
  }

  @Test
  fun refusalsHappenBeforeAnySdkWorkAndReleaseTheKey() {
    val engine = FakeEngine(Script.COMPLETE)
    val (capturing, capturedSource) = service({ engine }, capturing = true)
    assertEquals("RECORDING_NOT_SEALED", capturing.transcribe("r1", TestRecordings.ID).failure)

    val (tooLong, longSource) = service({ engine }, seconds = 181)
    assertEquals("UNSUPPORTED_DURATION", tooLong.transcribe("r2", TestRecordings.ID).failure)
    assertTrue("key zeroed", longSource().isClosed)
    assertEquals(emptyList<String>(), engine.log)

    val (exact, _) = service({ engine }, seconds = 180)
    assertEquals("exactly 180 s is accepted", "ok", exact.transcribe("r3", TestRecordings.ID).status)

    engine.refuseRegistration = "INSUFFICIENT_RESOURCES"
    val (refused, refusedSource) = service({ engine })
    assertEquals("INSUFFICIENT_RESOURCES", refused.transcribe("r4", TestRecordings.ID).failure)
    assertTrue("a source the SDK never took is closed by the app", refusedSource().isClosed)
    assertEquals(1, refusedSource().closeCount)
    assertTrue(capturedSource == capturedSource) // capture refusal opens no source
  }

  @Test
  fun anInvalidModelPackFailsClosedAndIsRetriedLater() {
    val engine = FakeEngine(Script.COMPLETE)
    var attempts = 0
    val (t, source) =
        service({
          attempts += 1
          if (attempts == 1) throw TranscriptionPack.Invalid() else engine
        })
    assertEquals("MODEL_PACK_INVALID", t.transcribe("r1", TestRecordings.ID).failure)
    assertTrue(source().isClosed)
    assertEquals("ok", t.transcribe("r2", TestRecordings.ID).status)
  }

  @Test
  fun teardownCancelsBeforeClosingTheClient() {
    val engine = FakeEngine(Script.HANG_UNTIL_CANCELLED)
    val (t, _) = service({ engine })
    val pending = t.async("r1")
    assertTrue(engine.started.await(5, TimeUnit.SECONDS))
    t.close()
    assertEquals(listOf("register", "operationEnded:cancelled", "registrationClose", "engineClose"), engine.log)
    assertEquals("cancelled", pending.get(5, TimeUnit.SECONDS).status)
  }

  @Test
  fun aDuplicateRequestIdDoesNotDisturbTheRunningOne() {
    val engine = FakeEngine(Script.HANG_UNTIL_CANCELLED)
    val (t, _) = service({ engine })
    val pending = t.async("r1")
    assertTrue(engine.started.await(5, TimeUnit.SECONDS))
    assertEquals("DUPLICATE_REQUEST", t.transcribe("r1", TestRecordings.ID).failure)
    assertEquals(1, t.activeCount())
    t.cancel("r1")
    assertEquals("cancelled", pending.get(5, TimeUnit.SECONDS).status)
  }
}
