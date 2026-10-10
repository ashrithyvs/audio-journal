package com.audiojournal.speech

import com.audiojournal.recording.PcmTap

/**
 * Live provisional text (ADR-017): the latest [windowMs] of captured audio is
 * transcribed every [cadenceMs] of new audio, on this transcriber's own
 * thread. Capture never waits: PCM is copied into a ring buffer, and while the
 * engine is busy, newer audio simply waits for the next window. Times are on
 * the capture timeline (pauses excluded), like the recording itself.
 *
 * PROVISIONAL: window, overlap, and cadence are Open decision 3 and are set
 * from device measurements before any performance claim.
 */
class LiveTranscriber(
    windowMs: Long,
    cadenceMs: Long,
    /** One engine pass; window-relative segments, or null if cancelled or failed. */
    private val transcribe: (FloatArray) -> List<RecordingPass.Segment>?,
    /** Asks a running pass to stop at its next abort point. */
    private val cancel: () -> Unit,
    /** Frees engine resources; called once, after the last pass. */
    private val release: () -> Unit,
    private val onWindow: (startMs: Long, endMs: Long, segments: List<RecordingPass.Segment>) -> Unit,
) : PcmTap {
  private val ring = ShortArray((windowMs * SAMPLES_PER_MS).toInt())
  private val cadence = cadenceMs * SAMPLES_PER_MS
  private val lock = Object()
  private var total = 0L
  private var closed = false
  private var released = false
  private val worker = Thread({ loop() }, "aj-live-transcript")

  init {
    worker.start()
  }

  override fun append(pcm: ByteArray, offset: Int, length: Int) {
    synchronized(lock) {
      if (closed) return
      var at = offset
      while (at + 1 < offset + length) {
        ring[(total % ring.size).toInt()] =
            ((pcm[at].toInt() and 0xff) or (pcm[at + 1].toInt() shl 8)).toShort()
        total += 1
        at += 2
      }
      lock.notifyAll()
    }
  }

  /** Stops after the current pass; does not wait for it. */
  override fun close() {
    synchronized(lock) {
      if (closed) return
      closed = true
      if (!released) cancel()
      lock.notifyAll()
    }
  }

  private fun loop() {
    var lastEnd = 0L
    try {
      while (true) {
        val start: Long
        val window: FloatArray
        synchronized(lock) {
          while (!closed && total - lastEnd < cadence) lock.wait()
          if (closed) return
          val end = total
          start = maxOf(0L, end - ring.size)
          window = FloatArray((end - start).toInt()) { ring[((start + it) % ring.size).toInt()] / 32_768f }
          lastEnd = end
        }
        val segments = transcribe(window) ?: continue
        val startMs = start / SAMPLES_PER_MS
        val lengthMs = window.size / SAMPLES_PER_MS
        onWindow(
            startMs,
            startMs + lengthMs,
            segments.map {
              val t0 = it.t0Ms.coerceIn(0, lengthMs)
              RecordingPass.Segment(startMs + t0, startMs + it.t1Ms.coerceIn(t0, lengthMs), it.text)
            })
      }
    } finally {
      synchronized(lock) {
        released = true
        closed = true
      }
      release()
    }
  }

  companion object {
    private const val SAMPLES_PER_MS = 16L

    /** PROVISIONAL (Open decision 3): replaced by device-measured values. */
    const val PROVISIONAL_WINDOW_MS = 8_000L
    const val PROVISIONAL_CADENCE_MS = 4_000L
  }
}
