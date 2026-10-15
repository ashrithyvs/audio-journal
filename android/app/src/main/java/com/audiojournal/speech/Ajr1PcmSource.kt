package com.audiojournal.speech

import ai.hybrid.sdk.PcmAudioSource
import ai.hybrid.sdk.PcmRead
import ai.hybrid.sdk.PcmReadStatus
import com.audiojournal.recording.Ajr1Reader
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.ShortBuffer
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.AEADBadTagException

/**
 * A sealed AJR1 recording as the SDK's read-only 16 kHz mono s16le source
 * (AJ ADR-022, SDK ADR-027). Each read decrypts only the frames its span
 * touches, straight into the SDK's buffer; the frame plaintext is zeroed by
 * [Ajr1Reader] after each copy, and no plaintext file is ever written. The
 * recording file is opened read-only and never changed.
 *
 * [close] zeroes the recording key. The SDK calls it exactly once (at the end
 * of the request, on registration close, or on runtime close); a second call
 * is a no-op. Reads and close are never concurrent for one registration, and
 * neither calls back into the SDK.
 */
class Ajr1PcmSource(private val reader: Ajr1Reader) : PcmAudioSource {
  override val frames: Long = reader.pcmBytes / 2

  private val closed = AtomicBoolean(false)
  private val closes = AtomicInteger(0)

  /** An authentication failure was seen: the recording is damaged, not the model. */
  @Volatile var damaged = false
    private set

  /** How many times [close] was called (the SDK contract is exactly once). */
  val closeCount: Int
    get() = closes.get()

  val isClosed: Boolean
    get() = closed.get()

  override fun read(frameOffset: Long, out: ShortBuffer): PcmRead {
    if (closed.get()) return PcmRead(PcmReadStatus.CLOSED)
    if (frameOffset < 0) return PcmRead(PcmReadStatus.FAILED)
    if (frameOffset >= frames) return PcmRead(PcmReadStatus.END)
    val wanted = minOf(out.remaining().toLong(), frames - frameOffset).toInt()
    if (wanted == 0) return PcmRead(PcmReadStatus.OK, 0)
    var written = 0
    try {
      reader.read(frameOffset * 2, (frameOffset + wanted) * 2) { pcm, offset, length ->
        val samples = ByteBuffer.wrap(pcm, offset, length).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
        written += samples.remaining()
        out.put(samples)
        true
      }
    } catch (_: AEADBadTagException) {
      damaged = true
      return PcmRead(PcmReadStatus.FAILED)
    } catch (_: Exception) {
      return PcmRead(if (closed.get()) PcmReadStatus.CLOSED else PcmReadStatus.FAILED)
    }
    return if (written == wanted) PcmRead(PcmReadStatus.OK, written) else PcmRead(PcmReadStatus.FAILED)
  }

  override fun close() {
    // Every call is counted, so evidence can show the SDK closed it exactly once.
    closes.incrementAndGet()
    if (closed.compareAndSet(false, true)) reader.close()
  }
}
