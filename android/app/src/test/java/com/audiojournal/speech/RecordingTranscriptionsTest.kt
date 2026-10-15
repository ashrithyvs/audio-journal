package com.audiojournal.speech

import ai.hybrid.sdk.HybridAIException
import ai.hybrid.sdk.PcmAudioSource
import java.io.File
import java.nio.file.Files
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
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

  /**
   * Behaves like the SDK's queued execution: the producer emits `accepted` and
   * a partial, then follows [script]; a cancel ends the operation with one
   * `cancelled` terminal that the consumer still pulls; the SDK closes the
   * claimed source after the terminal, and the model lease is released a
   * little after the terminal (as the inference worker leaves).
   */
  inner class FakeEngine(@Volatile var script: Script) : TranscriptionEngine {
    val log: MutableList<String> = Collections.synchronizedList(mutableListOf())
    val started = CountDownLatch(1)
    val leases = AtomicInteger()
    val sources = Collections.synchronizedList(mutableListOf<PcmAudioSource>())
    var refuseRegistration: String? = null
    var leaseReleaseDelayMs = 50L

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
          if (!(source as Ajr1PcmSource).isClosed) source.close()
          log += "registrationClose"
        }
      }
    }

    override fun prepare(token: String, frames: Long, requestId: String, deadlineMs: Int): TranscriptionEngine.Execution {
      val source = sources.last() as Ajr1PcmSource
      val queue = LinkedBlockingQueue<TranscriptionEngine.Pulled>()
      val cancelled = CountDownLatch(1)
      val ended = java.util.concurrent.atomic.AtomicBoolean(false)
      return object : TranscriptionEngine.Execution {
        override fun run() {
          leases.incrementAndGet()
          val audioMs = frames * 1_000 / 16_000
          val seg = TranscriptionEventsTest.segment(0, 0, audioMs, "words")
          fun emit(type: String, data: String) = queue.put(TranscriptionEngine.Pulled.Event(type, data))
          fun terminal(type: String, data: String = "{}") {
            ended.set(true)
            log += "terminal:$type"
            emit(type, data)
            if (!source.isClosed) source.close()
            log += "sourceClosedBySdk"
            queue.put(TranscriptionEngine.Pulled.End)
            // The inference worker leaves slightly after the terminal.
            Thread {
                  Thread.sleep(leaseReleaseDelayMs)
                  log += "leaseReleased"
                  leases.decrementAndGet()
                }
                .start()
          }
          emit("accepted", "{}")
          emit("partial", TranscriptionEventsTest.partial(seg))
          started.countDown()
          when (script) {
            Script.COMPLETE -> terminal("completed", TranscriptionEventsTest.completed(listOf(seg), audioMs))
            Script.LATE_EVENTS -> {
              emit("completed", TranscriptionEventsTest.completed(listOf(seg), audioMs))
              log += "terminal:completed"
              emit("partial", TranscriptionEventsTest.partial(seg))
              terminal("cancelled")
            }
            Script.FAIL -> terminal("failed", JSONObject().put("code", "MODEL_UNAVAILABLE").toString())
            Script.FAIL_ON_READ -> {
              source.read(16_000, java.nio.ShortBuffer.allocate(16_000))
              terminal("failed", JSONObject().put("code", "SOURCE_READ_FAILED").toString())
            }
            Script.HANG_UNTIL_CANCELLED -> {
              cancelled.await()
              terminal("cancelled")
            }
            Script.IGNORE_CANCEL -> {
              Thread.sleep(1_500) // non-cooperative compute
              terminal("completed", TranscriptionEventsTest.completed(listOf(seg), audioMs))
            }
          }
        }

        override fun next(timeoutMs: Int): TranscriptionEngine.Pulled =
            queue.poll(timeoutMs.toLong(), TimeUnit.MILLISECONDS) ?: TranscriptionEngine.Pulled.Timeout

        override fun cancel() {
          // After the terminal a cancel is a no-op, as in the SDK.
          if (!ended.get() && cancelled.count > 0L) log += "operationCancel"
          cancelled.countDown()
        }

        override fun close() = Unit
      }
    }

    override fun activeLeases() = leases.get()

    override fun close() {
      log += "engineClose"
    }
  }

  private var epoch = 1L

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
            unlockEpoch = { epoch },
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

  /** The SDK-side order every cancel must produce: cancel, terminal, lease, then close. */
  private val cancelOrder =
      listOf("register", "operationCancel", "terminal:cancelled", "sourceClosedBySdk", "leaseReleased", "registrationClose")

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
    assertEquals(
        listOf("registered", "terminal:completed", "producerEnded", "leaseReleased", "registrationClosed", "sourceCloses:1"),
        steps(t))
    assertEquals(listOf("register", "terminal:completed", "sourceClosedBySdk", "leaseReleased", "registrationClose"), engine.log)
  }

  @Test
  fun userCancelObservesTheTerminalAndLeaseBeforeClosing() {
    val engine = FakeEngine(Script.HANG_UNTIL_CANCELLED)
    val (t, source) = service({ engine })
    val pending = t.async("r1")
    assertTrue(engine.started.await(5, TimeUnit.SECONDS))
    t.cancel("r1")
    val result = pending.get(5, TimeUnit.SECONDS)
    assertEquals("cancelled", result.status)
    assertTrue(result.segments.isEmpty())
    assertEquals(cancelOrder, engine.log)
    assertEquals(1, source().closeCount)
    assertEquals(0, engine.activeLeases())
    assertEquals(0, t.activeCount())
    assertEquals(
        listOf("registered", "cancelRequested", "terminal:cancelled", "producerEnded", "leaseReleased",
            "registrationClosed", "sourceCloses:1"),
        steps(t))
  }

  @Test
  fun lockCancelsWaitsForTerminalAndLeaseThenClosesAndRefusesUntilUnlock() {
    val engine = FakeEngine(Script.HANG_UNTIL_CANCELLED)
    val (t, source) = service({ engine })
    val pending = t.async("r1")
    assertTrue(engine.started.await(5, TimeUnit.SECONDS))
    assertEquals(1, t.cancelAll())
    // cancelAll returned only after the terminal, the lease release, and the close.
    assertEquals(cancelOrder, engine.log)
    assertEquals(1, source().closeCount)
    assertEquals(0, t.activeCount())
    assertEquals("cancelled", pending.get(5, TimeUnit.SECONDS).status)
    // Until the vault is unlocked again nothing new starts (no key, no audio).
    engine.script = Script.COMPLETE
    assertEquals("LOCKED", t.transcribe("r2", TestRecordings.ID).failure)
    assertEquals(cancelOrder, engine.log)
    epoch += 1 // unlock
    assertEquals("ok", t.transcribe("r3", TestRecordings.ID).status)
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
  fun aLockRecordedBeforeTheInstanceExistedStillRefuses() {
    val engine = FakeEngine(Script.COMPLETE)
    val file = TestRecordings.write(dir, TestRecordings.samples(16_000))
    val t =
        RecordingTranscriptions(
            { engine }, { TestRecordings.open(file) }, { false }, unlockEpoch = { epoch }, lockedAtEpoch = epoch)
    assertEquals("LOCKED", t.transcribe("r1", TestRecordings.ID).failure)
    assertEquals(emptyList<String>(), engine.log)
    epoch += 1
    assertEquals("ok", t.transcribe("r2", TestRecordings.ID).status)
  }

  @Test
  fun aStuckStreamTimesOutAsAFailureNotAUserCancel() {
    val engine = FakeEngine(Script.HANG_UNTIL_CANCELLED)
    val file = TestRecordings.write(dir, TestRecordings.samples(16_000))
    val t =
        RecordingTranscriptions(
            { engine }, { TestRecordings.open(file) }, { false }, deadlineMs = 50, deadlineGraceMs = 50)
    val result = t.transcribe("r1", TestRecordings.ID)
    assertEquals("failed", result.status)
    assertEquals("TRANSCRIPTION_TIMEOUT", result.failure)
    assertEquals(cancelOrder, engine.log)
    assertTrue(steps(t).contains("watchdogCancel"))
  }

  @Test
  fun aCancelBeforeTheRequestStartsIsHonoured() {
    val engine = FakeEngine(Script.COMPLETE)
    val (t, _) = service({ engine })
    t.cancel("r1")
    assertEquals("cancelled", t.transcribe("r1", TestRecordings.ID).status)
    assertEquals(emptyList<String>(), engine.log)
    assertEquals("ok", t.transcribe("r2", TestRecordings.ID).status)
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
    val (capturing, _) = service({ engine }, capturing = true)
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
    assertEquals(cancelOrder + "engineClose", engine.log)
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
