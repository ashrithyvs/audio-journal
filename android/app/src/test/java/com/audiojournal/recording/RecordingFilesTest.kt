package com.audiojournal.recording

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.RandomAccessFile
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList
import javax.crypto.AEADBadTagException
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/** Reading, playing, scanning, and recovering recording files (ADR-017, LLD §9). */
class RecordingFilesTest {
  private lateinit var dir: File
  private lateinit var files: RecordingFiles
  private val root = ByteArray(32) { (it * 3 + 9).toByte() }
  private val idA = "rec_" + "a".repeat(26)
  private val idB = "rec_" + "b".repeat(26)

  private fun pcm(seed: Int, bytes: Int) = ByteArray(bytes) { (seed * 17 + it * 3).toByte() }

  /** Frames of the given PCM lengths; returns the concatenated plaintext. */
  private fun record(id: String, vararg lengths: Int): ByteArray {
    val all = ByteArrayOutputStream()
    Ajr1Writer.create(files.fileFor(id), id, root).use { writer ->
      lengths.forEachIndexed { i, length ->
        val chunk = pcm(i, length)
        all.write(chunk)
        writer.append(chunk)
      }
    }
    return all.toByteArray()
  }

  private fun reader(id: String) =
      Ajr1Reader(Ajr1.FileSource(RandomAccessFile(files.fileFor(id), "r")), root, id)

  private fun readRange(id: String, start: Long, end: Long): ByteArray {
    val out = ByteArrayOutputStream()
    reader(id).use { r ->
      r.read(start, end) { pcm, offset, length ->
        out.write(pcm, offset, length)
        true
      }
    }
    return out.toByteArray()
  }

  @Before
  fun setUp() {
    dir = Files.createTempDirectory("recording-files").toFile()
    files = RecordingFiles(dir)
  }

  @After
  fun tearDown() {
    dir.deleteRecursively()
  }

  @Test
  fun readsExactRangesAcrossFullAndPartialFrames() {
    val plain = record(idA, 32_000, 6_400, 32_000)
    reader(idA).use { assertEquals(plain.size.toLong(), it.pcmBytes) }
    assertArrayEquals(plain, readRange(idA, 0, plain.size.toLong()))
    // A range that starts inside frame 0 and ends inside frame 2.
    assertArrayEquals(plain.copyOfRange(31_000, 40_000), readRange(idA, 31_000, 40_000))
    // Past the end yields nothing.
    assertEquals(0, readRange(idA, 80_000, 90_000).size)
  }

  @Test
  fun aTamperedFrameStopsReadingWithAnAuthenticationFailure() {
    val plain = record(idA, 32_000, 32_000)
    val file = files.fileFor(idA)
    val bytes = file.readBytes()
    bytes[bytes.size - 20] = (bytes[bytes.size - 20].toInt() xor 1).toByte()
    file.writeBytes(bytes)
    val delivered = ByteArrayOutputStream()
    try {
      reader(idA).use { r ->
        r.read(0) { pcm, offset, length ->
          delivered.write(pcm, offset, length)
          true
        }
      }
      fail("tampering was not detected")
    } catch (_: AEADBadTagException) {
      // Only the authentic first frame was delivered.
      assertArrayEquals(plain.copyOf(32_000), delivered.toByteArray())
    }
  }

  @Test
  fun scansAuthenticateOnlyNamedRecordingsAndListEverythingElse() {
    record(idA, 32_000, 4_000)
    record(idB, 32_000)
    File(files.recordings, "notes.txt").writeText("x")
    val list = files.scan(setOf(idA)) { root.copyOf() }
    assertEquals(3, list.length())
    val scans =
        (0 until list.length()).map { list.getJSONObject(it) }.associateBy { it.getString("relativePath") }
    val a = scans.getValue("recordings/$idA.ajr")
    assertEquals("authenticated", a.getString("check"))
    assertEquals(2, a.getInt("authenticatedChunks"))
    assertEquals(36_000L / 32, a.getLong("authenticatedMs"))
    assertEquals(a.getLong("fileBytes"), a.getLong("byteCount"))
    assertEquals("none", a.getString("tail"))
    assertEquals(64, a.getString("contentSha256").length)
    val b = scans.getValue("recordings/$idB.ajr")
    assertEquals("header", b.getString("check"))
    assertTrue(b.getBoolean("headerValid"))
    assertEquals(files.fileFor(idB).length(), b.getLong("fileBytes"))
    val notes = scans.getValue("recordings/notes.txt")
    assertEquals("header", notes.getString("check"))
    assertFalse(notes.getBoolean("headerValid"))
  }

  @Test
  fun truncatesOnlyATornFinalFrameThatMatchesThePlan() {
    record(idA, 32_000, 32_000, 32_000)
    val file = files.fileFor(idA)
    val frame = Ajr1.FRAME_HEADER_BYTES + 32_000 + Ajr1.TAG_BYTES
    val valid = file.length() - frame
    // A torn write: the third frame's header landed, its ciphertext did not.
    RandomAccessFile(file, "rw").use { it.setLength(file.length() - 500) }
    assertFalse(files.dropTornTail(idA, 1, root)) // plan disagrees: untouched
    assertEquals(valid + frame - 500, file.length())
    val torn = files.scan(setOf(idA)) { root.copyOf() }.getJSONObject(0)
    assertEquals("torn", torn.getString("tail"))
    assertTrue(torn.has("contentSha256")) // kept audio is promotable
    assertTrue(files.dropTornTail(idA, 2, root))
    assertEquals(valid, file.length())

    // Damage in the middle is not a torn tail: nothing is cut.
    val bytes = file.readBytes()
    bytes[100] = (bytes[100].toInt() xor 1).toByte()
    file.writeBytes(bytes)
    assertFalse(files.dropTornTail(idA, 0, root))
    assertEquals(valid, file.length())
    val damaged = files.scan(setOf(idA)) { root.copyOf() }.getJSONObject(0)
    assertEquals("damaged", damaged.getString("tail"))
    assertFalse(damaged.has("contentSha256"))
  }

  @Test
  fun quarantineMovesFilesAsideAndRefusesPathsOutsideTheRoot() {
    record(idA, 3_200)
    assertTrue(files.quarantine("recordings/$idA.ajr", 42))
    assertFalse(files.fileFor(idA).exists())
    assertTrue(File(files.quarantine, "42-$idA.ajr").exists())
    for (bad in listOf("recordings/../vault/vault.bin", "journal/journal.db", "recordings/", "recordings/a/b")) {
      try {
        files.quarantine(bad, 1)
        fail("accepted $bad")
      } catch (_: IllegalArgumentException) {}
    }
    files.eraseAll()
    assertFalse(files.recordings.exists() || files.quarantine.exists())
  }

  @Test
  fun playbackDeliversTheRangeThenEndsAndPauseReportsThePosition() {
    val plain = record(idA, 32_000, 32_000)
    val sink = MemorySink()
    val events = PlaybackEvents()
    PlaybackSession(reader(idA), sink, 500, 1_500, events, pollMs = 1).start()
    events.await { it.ended }
    assertArrayEquals(plain.copyOfRange(16_000, 48_000), sink.written())
    assertEquals(1_500L, events.positions.last())

    val held = MemorySink(capacity = 6_400) // blocks after 200 ms of audio
    val paused = PlaybackEvents()
    val session = PlaybackSession(reader(idA), held, 0, null, paused, pollMs = 1)
    session.start()
    held.awaitFull()
    held.played = 6_400 // bytes: 200 ms reached the speaker
    session.pause("user")
    assertEquals(listOf(200L), paused.pausedAt)
    assertFalse(paused.ended)
  }

  @Test
  fun playbackOfDamagedAudioFailsAsSourceDamaged() {
    record(idA, 32_000, 32_000)
    val file = files.fileFor(idA)
    val bytes = file.readBytes()
    bytes[bytes.size - 1] = (bytes[bytes.size - 1].toInt() xor 1).toByte()
    file.writeBytes(bytes)
    val events = PlaybackEvents()
    PlaybackSession(reader(idA), MemorySink(), 0, null, events, pollMs = 1).start()
    events.await { it.failed != null }
    assertEquals("SOURCE_DAMAGED", events.failed)
  }

  /** A speaker that plays instantly unless a capacity makes it block. */
  private class MemorySink(private val capacity: Int = Int.MAX_VALUE) : PcmSink {
    private val out = ByteArrayOutputStream()
    @Volatile private var stopped = false
    /** Bytes the speaker has played; by default, everything written. */
    @Volatile var played: Long = -1
    private val lock = Object()

    override fun play() = Unit

    override fun write(pcm: ByteArray, offset: Int, length: Int): Int {
      synchronized(lock) {
        while (!stopped && out.size() + length > capacity) lock.wait(1)
        if (stopped) return 0
        out.write(pcm, offset, length)
        return length
      }
    }

    override val playedSamples: Long
      get() = if (played >= 0) played / 2 else synchronized(lock) { out.size() / 2L }

    override fun stop() {
      stopped = true
    }

    override fun release() = Unit

    fun written(): ByteArray = synchronized(lock) { out.toByteArray() }

    fun awaitFull() {
      val deadline = System.nanoTime() + 5_000_000_000L
      while (synchronized(lock) { out.size() } < capacity) {
        if (System.nanoTime() > deadline) fail("sink never filled")
        Thread.sleep(1)
      }
    }
  }

  private class PlaybackEvents : PlaybackListener {
    val positions = CopyOnWriteArrayList<Long>()
    val pausedAt = CopyOnWriteArrayList<Long>()
    @Volatile var ended = false
    @Volatile var failed: String? = null

    override fun onPosition(positionMs: Long) {
      positions += positionMs
    }

    override fun onPaused(positionMs: Long) {
      pausedAt += positionMs
    }

    override fun onEnded() {
      ended = true
    }

    override fun onFailed(code: String) {
      failed = code
    }

    fun await(condition: (PlaybackEvents) -> Boolean) {
      val deadline = System.nanoTime() + 5_000_000_000L
      while (!condition(this)) {
        if (System.nanoTime() > deadline) fail("timed out")
        Thread.sleep(1)
      }
    }
  }
}
