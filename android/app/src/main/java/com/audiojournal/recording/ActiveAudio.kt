package com.audiojournal.recording

import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors

/**
 * The process's one capture and one playback (ADR-017). Every control call,
 * including close on lock, runs on one thread, so locking never races a
 * pause or a finish. Closing seals what was captured and zeroes the keys.
 */
object ActiveAudio {
  private val control = Executors.newSingleThreadExecutor { Thread(it, "aj-audio-control") }

  // Touched only on the control thread.
  var capture: CaptureSession? = null
  var captureFocus: AudioFocus? = null
  var playback: PlaybackSession? = null
  var playbackFocus: AudioFocus? = null

  /** Runs on the control thread; rethrows the work's own exception. */
  fun <T> submit(work: () -> T): T =
      try {
        control.submit(Callable { work() }).get()
      } catch (failure: ExecutionException) {
        throw failure.cause ?: failure
      }

  fun execute(work: () -> Unit) = control.execute(work)

  fun stopPlayback() {
    playback?.stop()
    playback = null
    playbackFocus?.abandon()
    playbackFocus = null
  }

  fun releaseCapture() {
    capture?.close()
    capture = null
    captureFocus?.abandon()
    captureFocus = null
  }

  /** Vault lock, erase, or teardown. */
  fun closeAll() = submit {
    stopPlayback()
    releaseCapture()
  }
}
