package com.audiojournal.recording

import com.audiojournal.vault.VaultCrypto
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile

/** Microphone PCM, 16 kHz mono s16le (AudioRecord in production). */
interface PcmSource {
  fun start()

  /** Blocks until PCM is available; returns the bytes read, or a negative error. */
  fun read(buffer: ByteArray, offset: Int, length: Int): Int

  fun stop()

  fun release()
}

/**
 * ADR-017 capture limits: the same values as
 * `src/features/journal/domain/storagePolicy.ts`. JavaScript decides when a
 * limit finishes the recording; native capture stops at the limit itself so
 * a recording never exceeds it, even if JavaScript is slow.
 */
data class CaptureLimits(
    val maxPcmBytes: Long,
    val minFreeBytesToStart: Long,
    val autoFinishBelowFreeBytes: Long,
) {
  companion object {
    private const val MIB = 1024L * 1024L
    val ADR_017 = CaptureLimits(3_600L * Ajr1.MAX_CHUNK_BYTES, 200 * MIB, 50 * MIB)
  }
}

class CaptureProgress(
    val capturedMs: Long,
    val sealedChunks: Int,
    val byteCount: Long,
    val freeBytes: Long,
    val level: Double,
)

class FinalizedCapture(
    val durationMs: Long,
    val sealedChunks: Int,
    val byteCount: Long,
    val contentSha256: String,
)

/**
 * Receives a copy of each captured PCM block (live transcription). Called on
 * the capture thread, so it must only copy and return; a failure is ignored.
 */
interface PcmTap {
  fun append(pcm: ByteArray, offset: Int, length: Int)

  fun close()
}

/** Called on the capture thread (progress, ended) or the control thread (paused). */
interface CaptureListener {
  fun onProgress(progress: CaptureProgress)

  /** A pause the recorder made itself (focus loss, backgrounding). */
  fun onPaused(reason: String)

  fun onEnded(cause: String, progress: CaptureProgress)
}

/**
 * One capture (ADR-017, LLD §5): reads PCM into 1-second chunks and seals
 * each complete chunk into the AJR1 file as it fills. Pausing, finishing,
 * reaching a limit, or closing seals the partial chunk, so the file never
 * holds less than what was captured before the last seal. Plaintext exists
 * only in the chunk buffer, which is zeroed after each seal.
 *
 * Control methods are called from one control thread (the module's executor),
 * never from the capture thread or listener callbacks.
 */
class CaptureSession(
    val recordingId: String,
    private val file: File,
    private val writer: Ajr1Writer,
    private val source: PcmSource,
    private val freeBytes: () -> Long,
    private val recordingRootKey: () -> ByteArray,
    private val listener: CaptureListener,
    private val limits: CaptureLimits = CaptureLimits.ADR_017,
    private val readBytes: Int = 3_200, // 100 ms
) {
  enum class State { PREPARED, RECORDING, PAUSED, LIMITED, FINISHED, FAILED, CLOSED }

  @Volatile var state = State.PREPARED
    private set

  /** Live transcription's view of the audio; closed when the capture ends. */
  @Volatile var tap: PcmTap? = null

  @Volatile private var running = false
  private var thread: Thread? = null
  private val chunk = ByteArray(Ajr1.MAX_CHUNK_BYTES)
  private var filled = 0
  private var capturedBytes = 0L
  private var sealedChunks = 0
  private var lastFree = Long.MAX_VALUE
  private var failure: String? = null

  fun start() {
    check(state == State.PREPARED) { "RECORDER_STATE" }
    begin()
  }

  /** Starts paused: another app holds audio focus (for example, a call). */
  fun startPaused(reason: String) {
    check(state == State.PREPARED) { "RECORDER_STATE" }
    state = State.PAUSED
    listener.onPaused(reason)
  }

  /** Seals the partial chunk and stops reading. Returns false if not recording. */
  fun pause(reason: String): Boolean {
    if (state != State.RECORDING) return false
    stopCapture()
    if (state != State.RECORDING) return false // ended at a limit or failed meanwhile
    state = State.PAUSED
    if (reason != "user") listener.onPaused(reason)
    return true
  }

  fun resume() {
    if (state != State.PAUSED) return
    begin()
  }

  /**
   * Seals, closes, and reads the file back: success only when every frame
   * written authenticates, with nothing after it.
   */
  fun finish(): FinalizedCapture {
    stopCapture()
    closeTap()
    source.release()
    check(state == State.PAUSED || state == State.LIMITED || state == State.RECORDING) {
      failure ?: "RECORDER_STATE"
    }
    writer.close()
    state = State.FINISHED
    val key = recordingRootKey()
    val scan =
        try {
          RandomAccessFile(file, "r").use { Ajr1.scan(Ajr1.FileSource(it), key, recordingId) }
        } finally {
          VaultCrypto.zero(key)
        }
    if (scan.stop != null || scan.trailingBytes != 0L || scan.frames != sealedChunks) {
      throw IllegalStateException("RECORDING_VERIFY_FAILED")
    }
    // A header with no audio: nothing to keep (the entry fails as empty).
    if (scan.frames == 0) file.delete()
    return FinalizedCapture(
        scan.pcmBytes / PCM_BYTES_PER_MS, scan.frames, scan.validEnd, hex(scan.sha256))
  }

  /** The user confirmed discarding (AJ-FR-003); deletion is not secure erasure. */
  fun discard() {
    stopCapture()
    closeTap()
    writer.close()
    source.release()
    state = State.CLOSED
    file.delete()
  }

  /**
   * Lock or teardown: seals what was captured and zeroes the key. A capture
   * that was still open ends as interrupted; startup reconciliation then
   * keeps its sealed audio as recoverable.
   */
  fun close() {
    val wasOpen = state == State.RECORDING || state == State.PAUSED || state == State.LIMITED
    stopCapture()
    closeTap()
    writer.close()
    source.release()
    if (state != State.FINISHED && state != State.FAILED) state = State.CLOSED
    if (wasOpen) listener.onEnded("RECORDING_INTERRUPTED", progress(0.0))
  }

  private fun begin() {
    lastFree = freeBytes()
    running = true
    state = State.RECORDING
    thread = Thread({ captureLoop() }, "aj-capture").apply { start() }
  }

  private fun closeTap() {
    tap?.let { runCatching { it.close() } }
    tap = null
  }

  /** Idempotent; also waits for a capture thread that ended by itself. */
  private fun stopCapture() {
    running = false
    thread?.join()
    thread = null
  }

  private fun captureLoop() {
    var limited = false
    try {
      source.start()
      try {
        while (running) {
          val budget = limits.maxPcmBytes - capturedBytes
          if (budget <= 0 || lastFree < limits.autoFinishBelowFreeBytes) {
            limited = true
            break
          }
          val want = minOf(readBytes.toLong(), (chunk.size - filled).toLong(), budget).toInt()
          val read = source.read(chunk, filled, want)
          if (read < 0) throw IOException("AUDIO_READ_$read")
          if (read == 0) continue
          val level = peak(chunk, filled, read)
          tap?.let { runCatching { it.append(chunk, filled, read) } }
          filled += read
          capturedBytes += read
          if (filled == chunk.size) seal()
          listener.onProgress(progress(level))
        }
      } finally {
        source.stop()
      }
      seal()
      if (limited) {
        state = State.LIMITED
        listener.onProgress(progress(0.0))
      }
    } catch (error: Exception) {
      failure = if (noSpace(error)) "STORAGE_EXHAUSTED" else "RECORDER_FAILED"
      chunk.fill(0)
      filled = 0
      state = State.FAILED
      running = false
      writer.close()
      listener.onEnded(failure!!, progress(0.0))
    }
  }

  /** Seals the buffered PCM (whole samples only) as one frame. */
  private fun seal() {
    val length = filled - filled % 2
    if (length >= 2) {
      val pcm = chunk.copyOf(length)
      try {
        writer.append(pcm)
      } finally {
        VaultCrypto.zero(pcm)
      }
      sealedChunks += 1
      lastFree = freeBytes()
    }
    capturedBytes -= filled - length
    chunk.fill(0)
    filled = 0
  }

  private fun progress(level: Double) =
      CaptureProgress(
          capturedBytes / PCM_BYTES_PER_MS, sealedChunks, writer.fileBytes, lastFree, level)

  companion object {
    const val PCM_BYTES_PER_MS = 32L

    /** Peak absolute sample in the block, 0..1; display only. */
    fun peak(pcm: ByteArray, offset: Int, length: Int): Double {
      var max = 0
      var at = offset
      while (at + 1 < offset + length) {
        val sample = (pcm[at].toInt() and 0xff) or (pcm[at + 1].toInt() shl 8)
        max = maxOf(max, kotlin.math.abs(sample))
        at += 2
      }
      return minOf(1.0, max / 32_768.0)
    }

    fun noSpace(error: Throwable): Boolean {
      val message = error.message ?: return false
      return message.contains("ENOSPC") || message.contains("No space left")
    }

    fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
  }
}
