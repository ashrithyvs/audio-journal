package com.audiojournal.recording

import java.io.File
import java.nio.ByteBuffer
import java.nio.file.Files
import java.security.MessageDigest
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/** AJR1 as amended 2026-10-10: per-recording keys, indexed frames, safe resume. */
class Ajr1Test {
  private lateinit var dir: File
  private val root = ByteArray(32) { (it * 7 + 1).toByte() }
  private val idA = "rec_" + "a".repeat(26)
  private val idB = "rec_" + "b".repeat(26)

  /** Deterministic "CSPRNG": salt and prefix chosen per test. */
  private fun fixed(salt: Int, prefix: Int): (Int) -> ByteArray = { n ->
    if (n == 16) ByteArray(16) { (salt + it).toByte() } else ByteArray(n) { (prefix + it).toByte() }
  }

  private fun pcm(seed: Int, bytes: Int = 3_200) = ByteArray(bytes) { (seed * 31 + it).toByte() }

  private fun record(id: String, random: (Int) -> ByteArray, chunks: Int, name: String = id): File {
    val file = File(dir, "$name.ajr")
    Ajr1Writer.create(file, id, root, random).use { writer -> repeat(chunks) { writer.append(pcm(it)) } }
    return file
  }

  private fun frameStarts(bytes: ByteArray): List<Int> {
    val starts = mutableListOf<Int>()
    var at = Ajr1.HEADER_BYTES
    while (at < bytes.size) {
      starts += at
      at += Ajr1.FRAME_HEADER_BYTES + ByteBuffer.wrap(bytes, at + 8, 4).int + Ajr1.TAG_BYTES
    }
    return starts
  }

  private fun frame(bytes: ByteArray, number: Int): ByteArray {
    val starts = frameStarts(bytes) + bytes.size
    return bytes.copyOfRange(starts[number], starts[number + 1])
  }

  @Before
  fun setUp() {
    dir = Files.createTempDirectory("ajr1").toFile()
  }

  @After
  fun tearDown() {
    dir.deleteRecursively()
  }

  @Test
  fun roundTripsPcmAndDigest() {
    val file = record(idA, fixed(1, 9), 3)
    val chunks = mutableListOf<Pair<Long, ByteArray>>()
    val scan = Ajr1.scan(file.readBytes(), root, idA) { index, pcm -> chunks += index to pcm.copyOf() }
    assertEquals(3, scan.frames)
    assertNull(scan.stop)
    assertEquals(0L, scan.trailingBytes)
    assertEquals(listOf(0L, 1L, 2L), chunks.map { it.first })
    val expected = MessageDigest.getInstance("SHA-256").apply { repeat(3) { update(pcm(it)) } }.digest()
    assertArrayEquals(expected, scan.sha256)
    assertArrayEquals(pcm(1), chunks[1].second)
  }

  @Test
  fun identicalNoncePrefixesInDifferentRecordingsStillDiffer() {
    // Same salt AND prefix, different recording IDs: the key binds the ID.
    val a = record(idA, fixed(1, 9), 1).readBytes()
    val b = record(idB, fixed(1, 9), 1).readBytes()
    assertFalse(Ajr1.fileKey(root, ByteArray(16) { (1 + it).toByte() }, idA)
        .contentEquals(Ajr1.fileKey(root, ByteArray(16) { (1 + it).toByte() }, idB)))
    val frameA = frame(a, 0)
    val frameB = frame(b, 0)
    assertArrayEquals(frameA.copyOf(12), frameB.copyOf(12)) // same index and length
    assertFalse(frameA.contentEquals(frameB)) // ciphertext and tag differ
    assertFalse(frameA.copyOfRange(frameA.size - 16, frameA.size)
        .contentEquals(frameB.copyOfRange(frameB.size - 16, frameB.size)))
  }

  @Test
  fun sameRecordingIdWithDifferentSaltsUsesDifferentKeys() {
    val first = record(idA, fixed(1, 9), 1, "first").readBytes()
    val second = record(idA, fixed(2, 9), 1, "second").readBytes()
    assertFalse(frame(first, 0).contentEquals(frame(second, 0)))
    assertFalse(Ajr1.fileKey(root, ByteArray(16) { 1 }, idA).contentEquals(Ajr1.fileKey(root, ByteArray(16) { 2 }, idA)))
  }

  @Test
  fun wrongIdSaltHeaderOrIndexFailsAuthentication() {
    val bytes = record(idA, fixed(1, 9), 2).readBytes()
    assertEquals("AUTH_FAILED", Ajr1.scan(bytes, root, idB).stop)
    assertEquals("AUTH_FAILED", Ajr1.scan(bytes, ByteArray(32), idA).stop)
    for (offset in listOf(16, 31, 32, 35)) { // salt and nonce prefix bytes
      val tampered = bytes.copyOf().also { it[offset] = (it[offset].toInt() xor 1).toByte() }
      assertEquals("offset $offset", "AUTH_FAILED", Ajr1.scan(tampered, root, idA).stop)
    }
    // Rewriting the first frame's index to a later one keeps order but fails.
    val reindexed = bytes.copyOf().also { ByteBuffer.wrap(it, Ajr1.HEADER_BYTES, 8).putLong(5) }
    val scan = Ajr1.scan(reindexed, root, idA)
    assertEquals("AUTH_FAILED", scan.stop)
    assertEquals(0, scan.frames)
    // Strict header: a nonzero reserved byte or a different format is refused.
    for (offset in listOf(14, 40, 63, 8)) {
      try {
        Ajr1.scan(bytes.copyOf().also { it[offset] = (it[offset].toInt() xor 1).toByte() }, root, idA)
        fail("header offset $offset accepted")
      } catch (_: IllegalArgumentException) {}
    }
  }

  @Test
  fun duplicateDecreasingAndReorderedIndicesAreRejectedButGapsAreFine() {
    val header = Ajr1.Header(ByteArray(16) { 3 }, ByteArray(4) { 4 }).encode()
    val key = Ajr1.fileKey(root, ByteArray(16) { 3 }, idA)
    fun file(vararg indices: Long) =
        header + indices.map { Ajr1.sealFrame(key, header, ByteArray(4) { 4 }, idA, it, pcm(it.toInt())) }
            .reduce(ByteArray::plus)
    assertNull(Ajr1.scan(file(0, 5, 9), root, idA).stop) // gaps allowed
    assertEquals(3, Ajr1.scan(file(0, 5, 9), root, idA).frames)
    for (indices in listOf(longArrayOf(0, 1, 1), longArrayOf(0, 2, 1), longArrayOf(1, 0))) {
      val scan = Ajr1.scan(file(*indices), root, idA)
      assertEquals(indices.joinToString(), "INDEX_ORDER", scan.stop)
      assertTrue(scan.trailingBytes > 0)
    }
  }

  @Test
  fun tornTailRecoveryNeverReusesAPossiblyConsumedIndex() {
    val file = record(idA, fixed(1, 9), 3)
    val full = file.readBytes()
    // A crash while writing frame 3: part of its ciphertext reached the disk.
    val writer = Ajr1Writer.create(File(dir, "scratch.ajr"), idA, root, fixed(1, 9), firstIndex = 3)
    writer.close()
    val torn = Ajr1.sealFrame(Ajr1.fileKey(root, ByteArray(16) { (1 + it).toByte() }, idA),
        full.copyOf(64), ByteArray(4) { (9 + it).toByte() }, idA, 3, pcm(3))
    file.appendBytes(torn.copyOf(torn.size - 40))
    Ajr1Writer.resume(file, idA, root).use { resumed ->
      assertEquals(4L, resumed.index) // never 3
      resumed.append(pcm(4))
    }
    val scan = Ajr1.scan(file.readBytes(), root, idA)
    assertNull(scan.stop)
    assertEquals(listOf(0L, 1L, 2L, 4L), mutableListOf<Long>().also { list ->
      Ajr1.scan(file.readBytes(), root, idA) { index, _ -> list += index }
    })
    // A readable torn index beyond last + 1 is skipped too.
    val withHeader = file.readBytes() + ByteBuffer.allocate(10).putLong(9).array()
    file.writeBytes(withHeader)
    Ajr1Writer.resume(file, idA, root).use { assertEquals(10L, it.index) }
    // A clean file resumes at last + 1.
    Ajr1Writer.resume(file, idA, root).use { assertEquals(5L, it.index) }
  }

  @Test
  fun recreatingAFileNeverReusesTheFormerKey() {
    val file = File(dir, "x.ajr")
    Ajr1Writer.create(file, idA, root).use { it.append(pcm(0)) }
    val old = file.readBytes()
    Ajr1Writer.create(file, idA, root).use { it.append(pcm(0)) }
    val recreated = file.readBytes()
    assertFalse(old.copyOfRange(16, 32).contentEquals(recreated.copyOfRange(16, 32))) // new salt
    // An old frame spliced under the new header no longer authenticates.
    val spliced = recreated.copyOf(64) + frame(old, 0)
    assertEquals("AUTH_FAILED", Ajr1.scan(spliced, root, idA).stop)
  }

  @Test
  fun maximumIndexAndOverflow() {
    Ajr1Writer.create(File(dir, "max.ajr"), idA, root, fixed(1, 9), firstIndex = Ajr1.MAX_INDEX).use { writer ->
      writer.append(pcm(0))
      try {
        writer.append(pcm(1))
        fail("index overflow accepted")
      } catch (failure: IllegalStateException) {
        assertEquals("AJR1_INDEX_OVERFLOW", failure.message)
      }
    }
    val scan = Ajr1.scan(File(dir, "max.ajr").readBytes(), root, idA)
    assertEquals(Ajr1.MAX_INDEX, scan.lastIndex)
    try {
      Ajr1.sealFrame(ByteArray(32), ByteArray(64), ByteArray(4), idA, Ajr1.MAX_INDEX + 1, pcm(0))
      fail("sealed beyond the maximum index")
    } catch (_: IllegalArgumentException) {}
    // A frame claiming an index past the maximum is refused while reading.
    val bytes = File(dir, "max.ajr").readBytes()
    val forged = bytes.copyOf().also { ByteBuffer.wrap(it, 64, 8).putLong(Ajr1.MAX_INDEX + 1) }
    assertEquals("INDEX_OVERFLOW", Ajr1.scan(forged, root, idA).stop)
    // Resuming after a torn write at the maximum cannot continue.
    File(dir, "max.ajr").appendBytes(ByteArray(5))
    try {
      Ajr1Writer.resume(File(dir, "max.ajr"), idA, root)
      fail("resumed past the maximum index")
    } catch (failure: IllegalStateException) {
      assertEquals("AJR1_INDEX_OVERFLOW", failure.message)
    }
  }

  @Test
  fun rejectsInvalidChunksAndIds() {
    Ajr1Writer.create(File(dir, "odd.ajr"), idA, root).use { writer ->
      for (bad in listOf(ByteArray(0), ByteArray(3), ByteArray(Ajr1.MAX_CHUNK_BYTES + 2))) {
        try {
          writer.append(bad)
          fail("chunk of ${bad.size} bytes accepted")
        } catch (_: IllegalArgumentException) {}
      }
    }
    try {
      Ajr1.encodedInfo("rec_not-an-id")
      fail("malformed recording ID accepted")
    } catch (_: IllegalArgumentException) {}
  }
}
