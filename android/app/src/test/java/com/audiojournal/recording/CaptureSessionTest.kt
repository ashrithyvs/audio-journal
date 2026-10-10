package com.audiojournal.recording

import java.io.File
import java.io.RandomAccessFile
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/** Native capture (ADR-017, LLD §5) with a scripted microphone. */
class CaptureSessionTest {
  private lateinit var dir: File
  private val root = ByteArray(32) { (it * 5 + 3).toByte() }
  private val id = "rec_" + "c".repeat(26)
  private val mib = 1024L * 1024L

  /** A microphone fed by the test; read() blocks briefly and may return 0. */
  private class ScriptedSource : PcmSource {
    val queue = LinkedBlockingQueue<ByteArray>()
    @Volatile var failWith: Int? = null
    @Volatile var released = false
    private var pending = ByteArray(0)

    override fun start() = Unit

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
      failWith?.let { return it }
      if (pending.isEmpty()) pending = queue.poll(5, TimeUnit.MILLISECONDS) ?: return 0
      val count = minOf(length, pending.size)
      System.arraycopy(pending, 0, buffer, offset, count)
      pending = pending.copyOfRange(count, pending.size)
      return count
    }

    override fun stop() = Unit

    override fun release() {
      released = true
    }
  }

  private class Events : CaptureListener {
    val progress = CopyOnWriteArrayList<CaptureProgress>()
    val paused = CopyOnWriteArrayList<String>()
    val ended = CopyOnWriteArrayList<String>()

    override fun onProgress(progress: CaptureProgress) {
      this.progress += progress
    }

    override fun onPaused(reason: String) {
      paused += reason
    }

    override fun onEnded(cause: String, progress: CaptureProgress) {
      ended += cause
    }
  }

  private val source = ScriptedSource()
  private val events = Events()
  private val fed = MessageDigest.getInstance("SHA-256")
  private var fedBytes = 0L
  @Volatile private var free = 1_000 * mib

  private fun session(limits: CaptureLimits = CaptureLimits.ADR_017): CaptureSession {
    val file = File(dir, "$id.ajr")
    return CaptureSession(
        id, file, Ajr1Writer.create(file, id, root), source, { free }, { root.copyOf() }, events,
        limits)
  }

  private fun pcm(bytes: Int) = ByteArray(bytes) { ((fedBytes + it) * 13 % 251).toByte() }

  /** Feeds PCM and waits until the session has consumed all of it. */
  private fun feed(bytes: Int, expectCaptured: Long = (fedBytes + bytes) / 32) {
    val data = pcm(bytes)
    fed.update(data)
    fedBytes += bytes
    source.queue.put(data)
    waitFor { events.progress.lastOrNull()?.capturedMs == expectCaptured }
  }

  private fun waitFor(condition: () -> Boolean) {
    val deadline = System.nanoTime() + 5_000_000_000L
    while (!condition()) {
      if (System.nanoTime() > deadline) fail("timed out")
      Thread.sleep(2)
    }
  }

  private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

  private fun scan(file: File = File(dir, "$id.ajr")) =
      RandomAccessFile(file, "r").use { Ajr1.scan(Ajr1.FileSource(it), root, id) }

  @Before
  fun setUp() {
    dir = Files.createTempDirectory("capture").toFile()
  }

  @After
  fun tearDown() {
    dir.deleteRecursively()
  }

  @Test
  fun sealsEachSecondAndThePartialChunkOnPauseThenVerifiesOnFinish() {
    val capture = session()
    capture.start()
    feed(32_000 + 8_000) // one full chunk sealed, 0.25 s buffered
    assertEquals(1, events.progress.last().sealedChunks)
    assertTrue(capture.pause("user"))
    assertTrue(events.paused.isEmpty()) // the user's own pause is not echoed
    assertEquals(2, scan().frames) // the partial chunk was sealed on pause

    capture.resume()
    feed(16_000)
    val result = capture.finish()
    assertEquals(3, result.sealedChunks)
    assertEquals(fedBytes / 32, result.durationMs)
    assertEquals(hex(fed.digest()), result.contentSha256)
    assertEquals(File(dir, "$id.ajr").length(), result.byteCount)
    assertTrue(source.released)
  }

  @Test
  fun stopsExactlyAtTheDurationLimit() {
    val limit = 2L * 32_000 + 4_800
    val capture = session(CaptureLimits(limit, 0, 0))
    capture.start()
    feed(32_000)
    // More than the limit is offered; capture stops at the limit itself.
    source.queue.put(pcm(64_000))
    waitFor { capture.state == CaptureSession.State.LIMITED }
    assertEquals(limit / 32, events.progress.last().capturedMs)
    assertFalse(capture.pause("user")) // nothing left to pause
    val result = capture.finish()
    assertEquals(limit / 32, result.durationMs)
    assertEquals(3, result.sealedChunks)
  }

  @Test
  fun stopsWhenFreeSpaceFallsBelowTheAutoFinishThreshold() {
    val capture = session(CaptureLimits(Long.MAX_VALUE, 0, 50 * mib))
    capture.start()
    free = 49 * mib // measured after the next seal
    feed(32_000)
    source.queue.put(pcm(3_200))
    waitFor { capture.state == CaptureSession.State.LIMITED }
    assertEquals(49 * mib, events.progress.last().freeBytes)
    assertEquals(1, capture.finish().sealedChunks)
  }

  @Test
  fun aFailingMicrophoneEndsAbnormallyAndKeepsSealedAudio() {
    val capture = session()
    capture.start()
    feed(32_000 + 6_400)
    source.failWith = -3
    waitFor { events.ended.isNotEmpty() }
    assertEquals(listOf("RECORDER_FAILED"), events.ended.toList())
    assertEquals(CaptureSession.State.FAILED, capture.state)
    // The buffered partial chunk is lost with the device error; the sealed one stays.
    val scan = scan()
    assertEquals(1, scan.frames)
    assertNull(scan.stop)
    try {
      capture.finish()
      fail("finish after failure")
    } catch (expected: IllegalStateException) {
      assertEquals("RECORDER_FAILED", expected.message)
    }
  }

  @Test
  fun closingOnLockSealsAndReportsAnInterruption() {
    val capture = session()
    capture.start()
    feed(10_000)
    capture.close()
    assertEquals(listOf("RECORDING_INTERRUPTED"), events.ended.toList())
    assertEquals(1, scan().frames)
    assertTrue(source.released)
    // The writer's key is gone: nothing more can be appended.
    capture.resume()
    assertEquals(CaptureSession.State.CLOSED, capture.state)
  }

  @Test
  fun startingPausedRecordsNothingUntilResumed() {
    val capture = session()
    capture.startPaused("audio_focus_lost")
    assertEquals(listOf("audio_focus_lost"), events.paused.toList())
    capture.resume()
    feed(6_400)
    assertEquals(1, capture.finish().sealedChunks)
  }

  @Test
  fun anEmptyCaptureLeavesNoFileAndDiscardDeletes() {
    val empty = session()
    empty.startPaused("audio_focus_lost")
    assertEquals(0, empty.finish().sealedChunks)
    assertFalse(File(dir, "$id.ajr").exists())

    val discarded = session()
    discarded.start()
    feed(3_200)
    discarded.discard()
    assertFalse(File(dir, "$id.ajr").exists())
  }

  @Test
  fun levelIsThePeakSampleAndSpaceErrorsAreRecognized() {
    val pcm = byteArrayOf(0, 0, 0x00, 0x40, 0x00, 0x80.toByte()) // 0, 16384, -32768
    assertEquals(1.0, CaptureSession.peak(pcm, 0, 6), 0.0)
    assertEquals(0.5, CaptureSession.peak(pcm, 0, 4), 0.0)
    assertTrue(CaptureSession.noSpace(java.io.IOException("write failed: ENOSPC (No space left on device)")))
    assertFalse(CaptureSession.noSpace(java.io.IOException("EIO")))
  }
}
