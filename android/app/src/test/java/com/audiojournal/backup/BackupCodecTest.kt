package com.audiojournal.backup

import com.audiojournal.vault.KdfParams
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.security.MessageDigest
import javax.crypto.AEADBadTagException
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The production exporter and restorer against the frozen vectors: export of
 * the voice vector's journal must equal the reference archive byte for byte,
 * and restore must deliver the same records and PCM.
 */
class BackupCodecTest {
  private val dir = File("../../schemas/ajb1/v1").canonicalFile
  private val vectors = JSONObject(File(dir, "vectors.json").readText())
  private val voice =
      (0 until vectors.getJSONArray("valid").length())
          .map { vectors.getJSONArray("valid").getJSONObject(it) }
          .first { it.getString("name") == "voice-multisegment" }

  private fun hex(text: String) =
      ByteArray(text.length / 2) { text.substring(2 * it, 2 * it + 2).toInt(16).toByte() }

  private fun stream(label: String, length: Int): ByteArray {
    val out = ByteArray(length)
    var written = 0
    var counter = 0
    while (written < length) {
      val block =
          MessageDigest.getInstance("SHA-256").run {
            update("ajb1-vectors-v1:$label".toByteArray(Charsets.UTF_8))
            update(ByteBuffer.allocate(4).putInt(counter).array())
            digest()
          }
      val take = minOf(block.size, length - written)
      System.arraycopy(block, 0, out, written, take)
      written += take
      counter += 1
    }
    return out
  }

  @Suppress("UNCHECKED_CAST")
  private val records: List<Map<String, Any>> =
      String(File(dir, voice.getJSONObject("expect").getString("recordsFile")).readBytes(), Charsets.UTF_8)
          .split('\n')
          .filter { it.isNotEmpty() }
          .map { CanonicalJson.parse(it) as Map<String, Any> }

  private val pcm: Map<String, ByteArray> =
      voice.getJSONObject("expect").getJSONArray("pcm").let { list ->
        (0 until list.length()).associate {
          val entry = list.getJSONObject(it)
          val source = Regex("""stream\("(.+)", (\d+)\)""").find(entry.getString("source"))!!
          entry.getString("id") to stream(source.groupValues[1], source.groupValues[2].toInt())
        }
      }

  /** The vector journal as a database snapshot would present it. */
  private inner class VectorSnapshot : JournalSnapshot {
    override fun recordings() =
        records.filter { it["t"] == "recording" }.map {
          SnapshotRecording(
              it["id"] as String,
              it["entryId"] as String,
              it["state"] as String,
              it["startedAtMs"] as Long,
              it["endedAtMs"] as Long?,
              it["durationMs"] as Long,
              it["finishReason"] as String?,
              it["pcmSha256"] as String)
        }

    override fun forEachEntry(exclude: Set<String>, visit: (Map<String, Any>) -> Unit) =
        records.filter { it["t"] == "entry" && it["id"] !in exclude }.forEach(visit)

    override fun forEachSegment(exclude: Set<String>, visit: (Map<String, Any>) -> Unit) =
        records.filter { it["t"] == "transcriptSegment" && it["entryId"] !in exclude }.forEach(visit)
  }

  private open inner class VectorPcm(private val damaged: Set<String> = emptySet()) : RecordingPcm {
    override fun pcmBytes(recordingId: String): Long {
      if (recordingId in damaged) throw AEADBadTagException()
      return pcm.getValue(recordingId).size.toLong()
    }

    override fun authenticatedPrefix(recordingId: String): Pair<Long, String> {
      if (recordingId in damaged) throw AEADBadTagException()
      val bytes = pcm.getValue(recordingId)
      return bytes.size.toLong() to Ajb1.hex(MessageDigest.getInstance("SHA-256").digest(bytes))
    }

    override fun stream(recordingId: String, pcmBytes: Long, onPcm: (ByteArray, Int, Int) -> Unit) {
      val bytes = pcm.getValue(recordingId)
      var at = 0
      while (at < pcmBytes) {
        val take = minOf(32_000, pcmBytes.toInt() - at)
        onPcm(bytes.copyOfRange(at, at + take), 0, take)
        at += take
      }
    }
  }

  private fun random(): (Int) -> ByteArray {
    val inputs = voice.getJSONObject("random")
    return { size ->
      hex(
          when (size) {
            32 -> inputs.getString("dekHex")
            16 -> inputs.getString("saltHex")
            12 -> inputs.getString("wrapNonceHex")
            4 -> inputs.getString("noncePrefixHex")
            else -> error("unexpected random request $size")
          })
    }
  }

  private val kek = hex(voice.getString("kekHex"))

  private fun export(exporter: BackupExporter = BackupExporter(VectorSnapshot(), VectorPcm())): ByteArray {
    val plan = exporter.plan(voice.getLong("createdAtMs"))
    val out = ByteArrayOutputStream()
    exporter.write(plan, out, KdfParams(19_456, 2, 1), Ajb1.SECRET_RECOVERY_KEY, kek, random())
    assertEquals(plan.archiveBytes, out.size().toLong())
    return out.toByteArray()
  }

  @Test
  fun exportEqualsTheReferenceArchiveByteForByte() {
    val archive = export()
    assertArrayEquals(File(dir, voice.getString("file")).readBytes(), archive)
  }

  @Test
  fun aDamagedRecordingStopsTheExportUntilItsEntryIsExplicitlyLeftOut() {
    val damagedId = pcm.keys.first()
    val entryId = records.first { it["id"] == damagedId }["entryId"] as String
    val exporter = BackupExporter(VectorSnapshot(), VectorPcm(damaged = setOf(damagedId)))
    try {
      exporter.plan(1)
      fail("a damaged recording was exported")
    } catch (damaged: BackupExporter.Damaged) {
      assertEquals(listOf(entryId to damagedId), damaged.entries)
    }
    // After explicit confirmation: the entry, its recording, and its segments
    // are left out together, so the archive stays referentially complete.
    val plan = exporter.plan(1, exclude = setOf(entryId))
    assertEquals(1L, plan.counts["recording"])
    assertTrue(plan.recordings.none { it["entryId"] == entryId })
    val out = ByteArrayOutputStream()
    exporter.write(plan, out, KdfParams(19_456, 2, 1), Ajb1.SECRET_RECOVERY_KEY, kek, random())
    val opened = restorer().open(source(out.toByteArray()), Ajb1.SECRET_RECOVERY_KEY, ByteArray(0), Long.MAX_VALUE)
    assertEquals(1L, ((opened.manifest["pcm"] as Map<*, *>)["recordings"]))
  }

  private fun restorer() = BackupRestorer({ _, _, _ -> kek.copyOf() })

  private fun source(bytes: ByteArray) =
      object : ArchiveSource {
        override val size = bytes.size.toLong()

        override fun open() = ByteArrayInputStream(bytes)
      }

  @Test
  fun restoreOpensPreviewsAndStagesTheSameJournal() {
    val archive = File(dir, voice.getString("file")).readBytes()
    val phases = ArrayList<String>()
    restorer().open(source(archive), Ajb1.SECRET_RECOVERY_KEY, ByteArray(0), Long.MAX_VALUE, phases::add).use {
        opened ->
      assertEquals(listOf("prechecked", "authenticated"), phases)
      assertEquals(voice.getLong("createdAtMs"), opened.manifest["createdAtMs"])
      val staged = ArrayList<Map<String, Any>>()
      val audio = HashMap<String, ByteArrayOutputStream>()
      var current = ""
      restorer()
          .stage(
              source(archive),
              opened,
              object : ArchiveSink {
                override fun record(record: Map<String, Any>) {
                  staged.add(record)
                }

                override fun recordingStart(recording: Map<String, Any>) {
                  current = recording["id"] as String
                  audio[current] = ByteArrayOutputStream()
                }

                override fun pcm(bytes: ByteArray, offset: Int, length: Int) {
                  audio.getValue(current).write(bytes, offset, length)
                }
              })
      assertEquals(records, staged)
      for ((id, bytes) in pcm) assertArrayEquals(bytes, audio.getValue(id).toByteArray())
    }
  }

  @Test
  fun restoreRefusesBeforeTheKdfAndOnTheWrongSecret() {
    val archive = File(dir, voice.getString("file")).readBytes()
    var derived = 0
    val counting = BackupRestorer({ _, _, _ -> ByteArray(32).also { derived += 1 } })
    for ((kind, available, code) in
        listOf(
            Triple(Ajb1.SECRET_PASSWORD, Long.MAX_VALUE, "SECRET_KIND_MISMATCH"),
            Triple(Ajb1.SECRET_RECOVERY_KEY, 1_024L, "INSUFFICIENT_STORAGE"))) {
      try {
        counting.open(source(archive), kind, ByteArray(0), available)
        fail(code)
      } catch (failure: Ajb1.Failure) {
        assertEquals(code, failure.code)
      }
    }
    assertEquals(0, derived) // no KDF work before the pre-KDF checks pass
    try {
      counting.open(source(archive), Ajb1.SECRET_RECOVERY_KEY, ByteArray(0), Long.MAX_VALUE)
      fail("a wrong key opened the archive")
    } catch (failure: Ajb1.Failure) {
      assertEquals("AUTH_FAILED/unwrap", "${failure.code}/${failure.stage}")
    }
  }
}
