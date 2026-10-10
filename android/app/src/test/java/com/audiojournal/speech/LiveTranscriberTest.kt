package com.audiojournal.speech

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Live windows over the capture in progress (ADR-017); parameters are provisional. */
class LiveTranscriberTest {
  private class Window(val startMs: Long, val endMs: Long, val samples: Int)

  private fun waitFor(condition: () -> Boolean) {
    val deadline = System.nanoTime() + 5_000_000_000L
    while (!condition()) {
      if (System.nanoTime() > deadline) fail("timed out")
      Thread.sleep(2)
    }
  }

  private fun pcm(ms: Int) = ByteArray(ms * 32) { 1 }

  @Test
  fun transcribesTheLatestWindowEachCadenceOnTheCaptureTimeline() {
    val windows = CopyOnWriteArrayList<Window>()
    val released = AtomicInteger()
    val live =
        LiveTranscriber(
            windowMs = 1_000,
            cadenceMs = 500,
            transcribe = { pcm ->
              listOf(RecordingPass.Segment(0, pcm.size / 16L + 400, "x"))
            },
            cancel = {},
            release = { released.incrementAndGet() },
            onWindow = { start, end, segments ->
              windows += Window(start, end, segments.size)
              // Segments are clamped to the window.
              assertEquals(end, segments.single().t1Ms)
            })
    live.append(pcm(500), 0, 500 * 32)
    waitFor { windows.size == 1 }
    live.append(pcm(1_000), 0, 1_000 * 32)
    waitFor { windows.size == 2 }
    assertEquals(0L, windows[0].startMs)
    assertEquals(500L, windows[0].endMs)
    // Only the latest second is kept: the window slides forward.
    assertEquals(500L, windows[1].startMs)
    assertEquals(1_500L, windows[1].endMs)
    live.close()
    waitFor { released.get() == 1 }
    live.close()
    live.append(pcm(1_000), 0, 1_000 * 32) // after close: ignored
    Thread.sleep(20)
    assertEquals(2, windows.size)
    assertEquals(1, released.get())
  }

  @Test
  fun closingCancelsARunningPassAndCaptureNeverWaits() {
    val running = CountDownLatch(1)
    val cancelled = CountDownLatch(1)
    val released = AtomicInteger()
    val live =
        LiveTranscriber(
            windowMs = 1_000,
            cadenceMs = 100,
            transcribe = {
              running.countDown()
              cancelled.await(5, TimeUnit.SECONDS)
              null
            },
            cancel = { cancelled.countDown() },
            release = { released.incrementAndGet() },
            onWindow = { _, _, _ -> fail("a cancelled pass reports nothing") })
    live.append(pcm(200), 0, 200 * 32)
    assertTrue(running.await(5, TimeUnit.SECONDS))
    // The engine is busy; appending still returns at once.
    val started = System.nanoTime()
    repeat(50) { live.append(pcm(100), 0, 100 * 32) }
    assertTrue(System.nanoTime() - started < 1_000_000_000L)
    live.close()
    waitFor { released.get() == 1 }
  }
}
