package com.audiojournal.speech

import com.audiojournal.recording.Ajr1Reader

/**
 * The final transcription pass over a sealed recording (ADR-017), in bounded
 * windows so a 60-minute recording never becomes one float array (about
 * 230 MB). Each cut is moved to the quietest 20 ms in the [snapMs] before
 * its nominal position, so words are rarely split. Window segment times are
 * clamped to the window and offset by its start, so they stay ordered.
 *
 * PROVISIONAL defaults: chosen for memory, not from device measurements;
 * transcript quality across cuts is checked in validation evidence.
 */
class RecordingPass(
    private val reader: Ajr1Reader,
    private val windowMs: Long = WINDOW_MS,
    private val snapMs: Long = SNAP_MS,
) {
  class Segment(val t0Ms: Long, val t1Ms: Long, val text: String)

  /**
   * Calls [transcribe] once per window with its PCM as floats and the
   * window's start; it returns the window-relative segments, or null to stop.
   * Returns every segment in absolute time, or null if stopped.
   */
  fun run(
      transcribe: (startMs: Long, pcm: FloatArray) -> List<Segment>?,
  ): List<Segment>? {
    val total = reader.pcmBytes / 2
    val window = windowMs * SAMPLES_PER_MS
    val snap = snapMs * SAMPLES_PER_MS
    val out = ArrayList<Segment>()
    var start = 0L
    while (start < total) {
      val nominal = minOf(start + window, total)
      val samples = readSamples(start, nominal)
      val length =
          if (nominal == total) samples.size
          else quietestCut(samples, (samples.size - snap).toInt().coerceAtLeast(1))
      val pcm = FloatArray(length) { samples[it] / 32_768f }
      val startMs = start / SAMPLES_PER_MS
      val windowLengthMs = length / SAMPLES_PER_MS
      val segments = transcribe(startMs, pcm) ?: return null
      for (segment in segments) {
        val t0 = segment.t0Ms.coerceIn(0, windowLengthMs)
        val t1 = segment.t1Ms.coerceIn(t0, windowLengthMs)
        out.add(Segment(startMs + t0, startMs + t1, segment.text))
      }
      start += length
    }
    return out
  }

  private fun readSamples(from: Long, to: Long): ShortArray {
    val samples = ShortArray((to - from).toInt())
    var at = 0
    reader.read(from * 2, to * 2) { pcm, offset, length ->
      var byte = offset
      while (byte + 1 < offset + length) {
        samples[at++] = ((pcm[byte].toInt() and 0xff) or (pcm[byte + 1].toInt() shl 8)).toShort()
        byte += 2
      }
      true
    }
    return samples
  }

  companion object {
    const val WINDOW_MS = 300_000L
    const val SNAP_MS = 2_000L
    const val SAMPLES_PER_MS = 16L
    private const val FRAME = 320 // 20 ms

    /**
     * Start of the quietest 20 ms frame at or after [from]; ties go to the
     * later frame, nearest the nominal cut. Never 0.
     */
    fun quietestCut(samples: ShortArray, from: Int): Int {
      var best = samples.size
      var bestEnergy = Long.MAX_VALUE
      var frame = from
      while (frame + FRAME <= samples.size) {
        var energy = 0L
        for (i in frame until frame + FRAME) energy += kotlin.math.abs(samples[i].toInt())
        if (energy <= bestEnergy) {
          bestEnergy = energy
          best = frame
        }
        frame += FRAME
      }
      return best.coerceAtLeast(1)
    }
  }
}
