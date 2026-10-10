package com.audiojournal.recording

import javax.crypto.AEADBadTagException

/** 16 kHz mono s16le output ([AudioTrackSink] in production). */
interface PcmSink {
  fun play()

  /** Blocks while full; returns early (possibly short) once stopped. */
  fun write(pcm: ByteArray, offset: Int, length: Int): Int

  /** Samples played since [play]. */
  val playedSamples: Long

  fun stop()

  fun release()
}

interface PlaybackListener {
  fun onPosition(positionMs: Long)

  fun onPaused(positionMs: Long)

  fun onEnded()

  fun onFailed(code: String)
}

/**
 * Plays `[startMs, endMs)` of one AJR1 recording (ADR-017): frames are
 * authenticated as they are read, decrypted in memory, and written to the
 * sink in 100 ms slices. A frame that fails authentication ends playback
 * with `SOURCE_DAMAGED`; the file is never changed. Pausing stops at the
 * current position; the caller plays again from there.
 */
class PlaybackSession(
    private val reader: Ajr1Reader,
    private val sink: PcmSink,
    private val startMs: Long,
    private val endMs: Long?,
    private val listener: PlaybackListener,
    private val pollMs: Long = 50,
) {
  @Volatile private var running = true
  @Volatile private var pausedAt: Long? = null
  private var thread: Thread? = null

  fun start() {
    thread = Thread({ run() }, "aj-playback").apply { start() }
  }

  /** Stops at the current position and reports it (user or system pause). */
  fun pause(reason: String) = halt(reason)

  fun stop() = halt(null)

  private fun halt(reason: String?) {
    if (!running) return
    // Read before stopping: stopping resets the sink's play head.
    if (reason != null) pausedAt = position()
    running = false
    sink.stop()
    thread?.join()
    thread = null
  }

  private fun position() = startMs + sink.playedSamples / SAMPLES_PER_MS

  private fun run() {
    var written = 0L
    try {
      sink.play()
      val startByte = startMs * CaptureSession.PCM_BYTES_PER_MS
      val endByte =
          maxOf(startByte, endMs?.let { it * CaptureSession.PCM_BYTES_PER_MS } ?: reader.pcmBytes)
      var lastReport = -1L
      reader.read(startByte, endByte) { pcm, offset, length ->
        var at = offset
        while (running && at < offset + length) {
          val slice = minOf(SLICE_BYTES, offset + length - at)
          val count = sink.write(pcm, at, slice)
          if (count < 0) throw IllegalStateException("PLAYBACK_UNAVAILABLE")
          at += count
          written += count
          val now = position()
          if (now != lastReport) {
            listener.onPosition(now)
            lastReport = now
          }
        }
        running
      }
      // Let the buffered tail drain before reporting the end.
      val total = written / 2
      while (running && sink.playedSamples < total) Thread.sleep(pollMs)
      if (running) {
        running = false
        listener.onPosition(startMs + total / SAMPLES_PER_MS)
        listener.onEnded()
      }
    } catch (_: AEADBadTagException) {
      running = false
      listener.onFailed("SOURCE_DAMAGED")
    } catch (_: Exception) {
      if (running) {
        running = false
        listener.onFailed("PLAYBACK_UNAVAILABLE")
      }
    } finally {
      sink.stop()
      sink.release()
      reader.close()
      pausedAt?.let { listener.onPaused(it) }
    }
  }

  companion object {
    const val SAMPLES_PER_MS = 16L
    const val SLICE_BYTES = 3_200 // 100 ms
  }
}
