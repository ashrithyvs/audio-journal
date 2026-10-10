package com.audiojournal.speech

import com.audiojournal.recording.Ajr1
import com.audiojournal.recording.Ajr1Reader
import com.audiojournal.recording.Ajr1Writer
import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** The windowed final pass (ADR-017): bounded memory, quiet cuts, absolute times. */
class RecordingPassTest {
  private lateinit var dir: File
  private val root = ByteArray(32) { (it + 40).toByte() }
  private val id = "rec_" + "p".repeat(26)

  /** Loud everywhere except a silent 100 ms at each of [quietAtMs]. */
  private fun samples(totalMs: Int, vararg quietAtMs: Int): ShortArray =
      ShortArray(totalMs * 16) { i ->
        val ms = i / 16
        if (quietAtMs.any { ms in it until it + 100 }) 0
        else (if (i % 2 == 0) 9_000 else -9_000).toShort()
      }

  private fun reader(samples: ShortArray): Ajr1Reader {
    val file = File(dir, "$id.ajr")
    val bytes = ByteArray(samples.size * 2)
    samples.forEachIndexed { i, s ->
      bytes[2 * i] = s.toByte()
      bytes[2 * i + 1] = (s.toInt() shr 8).toByte()
    }
    Ajr1Writer.create(file, id, root).use { writer ->
      var at = 0
      while (at < bytes.size) {
        val end = minOf(at + Ajr1.MAX_CHUNK_BYTES, bytes.size)
        writer.append(bytes.copyOfRange(at, end))
        at = end
      }
    }
    return Ajr1Reader(Ajr1.FileSource(java.io.RandomAccessFile(file, "r")), root, id)
  }

  @Before
  fun setUp() {
    dir = Files.createTempDirectory("pass").toFile()
  }

  @After
  fun tearDown() {
    dir.deleteRecursively()
  }

  @Test
  fun coversEverySampleOnceAndCutsInTheQuietestPlace() {
    val pcm = samples(25_000, 9_200, 18_500)
    val starts = ArrayList<Long>()
    val heard = ArrayList<Float>()
    reader(pcm).use { r ->
      RecordingPass(r, windowMs = 10_000, snapMs = 2_000).run { startMs, window ->
        starts += startMs
        heard.addAll(window.toList())
        emptyList()
      }
    }
    // Each cut moved back from its nominal position into a silence.
    assertEquals(3, starts.size)
    assertTrue(starts[1] in 9_200L until 9_300L)
    assertTrue(starts[2] in 18_500L until 18_600L)
    assertEquals(pcm.size, heard.size)
    pcm.forEachIndexed { i, s -> assertEquals(s / 32_768f, heard[i], 0f) }
  }

  @Test
  fun offsetsAndClampsSegmentsSoTheyStayOrdered() {
    val pcm = samples(15_000, 7_000)
    val starts = ArrayList<Long>()
    val segments =
        reader(pcm).use { r ->
          RecordingPass(r, windowMs = 8_000, snapMs = 2_000).run { startMs, window ->
            starts += startMs
            val lengthMs = window.size / 16L
            listOf(
                RecordingPass.Segment(0, 1_000, "start"),
                RecordingPass.Segment(lengthMs - 500, lengthMs + 900, "overshoot"))
          }
        }!!
    val cut = starts[1]
    assertEquals(listOf(0L, cut - 500, cut, 14_500L), segments.map { it.t0Ms })
    assertEquals(cut, segments[1].t1Ms) // clamped to its window
    assertEquals(15_000L, segments[3].t1Ms)
    for (i in 1 until segments.size) assertTrue(segments[i].t0Ms >= segments[i - 1].t0Ms)
  }

  @Test
  fun stopsWhenTheEngineStops() {
    var calls = 0
    val result =
        reader(samples(20_000, 0)).use { r ->
          RecordingPass(r, windowMs = 5_000, snapMs = 1_000).run { _, _ ->
            calls += 1
            null
          }
        }
    assertNull(result)
    assertEquals(1, calls)
  }
}
