package com.audiojournal.speech

import ai.hybrid.sdk.PcmReadStatus
import com.audiojournal.recording.Ajr1
import com.audiojournal.recording.Ajr1Reader
import com.audiojournal.recording.Ajr1Writer
import java.io.File
import java.io.RandomAccessFile
import java.nio.ShortBuffer
import java.nio.file.Files
import java.security.MessageDigest
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** A sealed AJR1 recording as the SDK's read-only PCM source (AJ ADR-022). */
class Ajr1PcmSourceTest {
  private lateinit var dir: File

  @Before
  fun setUp() {
    dir = Files.createTempDirectory("ajr1-source").toFile()
  }

  @After
  fun tearDown() {
    dir.deleteRecursively()
  }

  @Test
  fun deliversExactSamplesAcrossFrameBoundariesInBoundedSpans() {
    val samples = TestRecordings.samples(2_500 * 16) // 2.5 s: frames of 1 s, 1 s, 0.5 s
    val file = TestRecordings.write(dir, samples)
    val before = sha256(file)
    val source = TestRecordings.open(file)
    assertEquals(samples.size.toLong(), source.frames)
    val out = ShortArray(samples.size)
    var offset = 0L
    for (span in listOf(7, 16_000, 333, 9_000, 100_000)) {
      val buffer = ShortBuffer.allocate(span)
      val read = source.read(offset, buffer)
      if (read.status == PcmReadStatus.END) break
      assertEquals(PcmReadStatus.OK, read.status)
      assertTrue(read.frames <= span)
      buffer.flip()
      buffer.get(out, offset.toInt(), read.frames)
      offset += read.frames
    }
    assertEquals(samples.size.toLong(), offset)
    assertArrayEquals(samples, out)
    assertEquals(PcmReadStatus.END, source.read(offset, ShortBuffer.allocate(16)).status)
    assertEquals(PcmReadStatus.OK, source.read(0, ShortBuffer.allocate(0)).status)
    assertEquals(PcmReadStatus.FAILED, source.read(-1, ShortBuffer.allocate(16)).status)
    source.close()
    assertEquals("the recording is never changed", before, sha256(file))
  }

  @Test
  fun closeZeroesTheKeyOnceAndLaterReadsReportClosed() {
    val source = TestRecordings.open(TestRecordings.write(dir, TestRecordings.samples(16_000)))
    source.close()
    source.close()
    assertEquals(2, source.closeCount)
    assertTrue(source.isClosed)
    assertEquals(PcmReadStatus.CLOSED, source.read(0, ShortBuffer.allocate(16)).status)
  }

  @Test
  fun aDamagedFrameFailsTheReadAndMarksTheSourceDamaged() {
    val file = TestRecordings.write(dir, TestRecordings.samples(3 * 16_000))
    // Flip one ciphertext byte inside the second frame.
    val secondFrame = Ajr1.HEADER_BYTES + Ajr1.FRAME_HEADER_BYTES + 32_000 + Ajr1.TAG_BYTES
    RandomAccessFile(file, "rw").use { raf ->
      val at = (secondFrame + Ajr1.FRAME_HEADER_BYTES + 10).toLong()
      raf.seek(at)
      val byte = raf.read()
      raf.seek(at)
      raf.write(byte xor 0x01)
    }
    val source = TestRecordings.open(file)
    assertEquals(PcmReadStatus.OK, source.read(0, ShortBuffer.allocate(16_000)).status)
    assertFalse(source.damaged)
    assertEquals(PcmReadStatus.FAILED, source.read(16_000, ShortBuffer.allocate(16_000)).status)
    assertTrue(source.damaged)
    source.close()
  }

  private fun sha256(file: File) =
      MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(it) }
}

/** Real AJR1 recordings for JVM tests (fixed root key, deterministic samples). */
object TestRecordings {
  val root = ByteArray(32) { (it * 5 + 3).toByte() }
  const val ID = "rec_0123456789abcdefghjkmnpqrs"

  fun samples(count: Int) = ShortArray(count) { ((it * 37) % 65_536 - 32_768).toShort() }

  fun write(dir: File, samples: ShortArray, id: String = ID): File {
    val file = File(dir, "$id.ajr")
    val bytes = ByteArray(samples.size * 2)
    samples.forEachIndexed { i, s ->
      bytes[2 * i] = (s.toInt() and 0xff).toByte()
      bytes[2 * i + 1] = (s.toInt() shr 8).toByte()
    }
    Ajr1Writer.create(file, id, root, syncEachFrame = false).use { writer ->
      var at = 0
      while (at < bytes.size) {
        val end = minOf(at + Ajr1.MAX_CHUNK_BYTES, bytes.size)
        writer.append(bytes.copyOfRange(at, end))
        at = end
      }
    }
    return file
  }

  fun open(file: File, id: String = ID) =
      Ajr1PcmSource(Ajr1Reader(Ajr1.FileSource(RandomAccessFile(file, "r")), root, id))
}
