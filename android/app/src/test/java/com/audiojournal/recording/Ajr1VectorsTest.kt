package com.audiojournal.recording

import java.io.File
import java.nio.ByteBuffer
import java.security.MessageDigest
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Cross-implementation check: schemas/ajr1/v1 was produced by the independent
 * Node reference (tools/ajb1-reference). This codec must rebuild every valid
 * file byte for byte and read every case to the same result.
 */
class Ajr1VectorsTest {
  private val dir = File("../../schemas/ajr1/v1").canonicalFile
  private val vectors = JSONObject(File(dir, "vectors.json").readText())
  private val root = hex(vectors.getString("recordingRootKeyHex"))
  private val prefix = hex(vectors.getString("noncePrefixHex"))

  private fun hex(text: String) = ByteArray(text.length / 2) { text.substring(2 * it, 2 * it + 2).toInt(16).toByte() }

  private fun toHex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

  /** SHA-256(utf8("ajb1-vectors-v1:" + label) || u32be(counter)) concatenated. */
  private fun stream(label: String, length: Int): ByteArray {
    val out = ByteArray(length)
    var written = 0
    var counter = 0
    while (written < length) {
      val block = MessageDigest.getInstance("SHA-256").run {
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

  private val pcmSpec = Regex("""^stream\("(.+)", (\d+)\)$""")

  @Test
  fun rebuildsEveryValidFileByteForByte() {
    val valid = vectors.getJSONArray("valid")
    for (n in 0 until valid.length()) {
      val vector = valid.getJSONObject(n)
      val id = vector.getString("recordingId")
      val salt = hex(vector.getString("saltHex"))
      assertEquals(vector.getString("encodedInfoHex"), toHex(Ajr1.encodedInfo(id)))
      val key = Ajr1.fileKey(root, salt, id)
      assertEquals(vector.getString("name"), vector.getString("fileKeyHex"), toHex(key))
      val header = Ajr1.Header(salt, prefix).encode()
      val frames = vector.getJSONArray("frames")
      var built = header
      for (f in 0 until frames.length()) {
        val frame = frames.getJSONObject(f)
        val (label, bytes) = pcmSpec.matchEntire(frame.getString("pcm"))!!.destructured
        built += Ajr1.sealFrame(key, header, prefix, id, frame.getLong("index"), stream(label, bytes.toInt()))
      }
      assertArrayEquals(vector.getString("name"), File(dir, vector.getString("file")).readBytes(), built)
    }
  }

  @Test
  fun readsEveryCaseLikeTheReference() {
    val cases =
        (0 until vectors.getJSONArray("valid").length()).map {
          vectors.getJSONArray("valid").getJSONObject(it).let { v -> Triple(v, v.getString("recordingId"), true) }
        } +
            (0 until vectors.getJSONArray("readCases").length()).map {
              vectors.getJSONArray("readCases").getJSONObject(it).let { v -> Triple(v, v.getString("readAs"), false) }
            }
    for ((vector, readAs, valid) in cases) {
      val name = vector.getString("name")
      val expect = vector.getJSONObject("expect")
      val indices = mutableListOf<Long>()
      val scan = Ajr1.scan(File(dir, vector.getString("file")).readBytes(), root, readAs) { index, _ -> indices += index }
      val expected = expect.getJSONArray("indices").let { a -> (0 until a.length()).map { a.getLong(it) } }
      assertEquals(name, expected, indices)
      assertEquals(name, expect.getLong("resumeIndex"), Ajr1.resumeIndex(scan))
      if (valid) {
        assertEquals(name, null, scan.stop)
        assertEquals(name, expect.getString("pcmSha256"), toHex(scan.sha256))
      } else {
        assertEquals(name, expect.getString("stop"), scan.stop)
        assertEquals(name, expect.getLong("trailingBytes"), scan.trailingBytes)
      }
    }
  }
}
