package com.audiojournal.backup

import com.audiojournal.vault.KdfParams
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

/**
 * Cross-implementation check against the frozen AJB1 vectors (§9.11), which
 * the independent Node reference produced. The Kotlin codec must rebuild every
 * valid archive byte for byte, read it to the same records and PCM digests,
 * and reject every hostile vector with the same code at the same stage.
 *
 * The JVM cannot load the app's libargon2, so the recorded KEK is used when
 * secret, salt, and parameters match a vector, and a wrong key otherwise
 * (any change to them changes the Argon2id output).
 */
class Ajb1VectorsTest {
  private val dir = File("../../schemas/ajb1/v1").canonicalFile
  private val vectors = JSONObject(File(dir, "vectors.json").readText())
  private val secrets = vectors.getJSONObject("secrets")
  private val valid = (0 until vectors.getJSONArray("valid").length()).map {
    vectors.getJSONArray("valid").getJSONObject(it)
  }
  private val hostile = (0 until vectors.getJSONArray("hostile").length()).map {
    vectors.getJSONArray("hostile").getJSONObject(it)
  }
  private val wrongKey = ByteArray(32) { 0x55 }

  private fun hex(text: String) =
      ByteArray(text.length / 2) { text.substring(2 * it, 2 * it + 2).toInt(16).toByte() }

  private fun sha(bytes: ByteArray) = Ajb1.hex(MessageDigest.getInstance("SHA-256").digest(bytes))

  /** SHA-256(utf8("ajb1-vectors-v1:" + label) || u32be(counter)) concatenated. */
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

  private fun file(path: String) = File(dir, path).readBytes()

  /** org.json values as plain maps, lists, and longs (key order irrelevant). */
  private fun plain(value: Any): Any =
      when (value) {
        is JSONObject -> value.keys().asSequence().associateWith { plain(value.get(it)) }
        is JSONArray -> (0 until value.length()).map { plain(value.get(it)) }
        is Int -> value.toLong()
        else -> value
      }

  private fun secretKind(name: String) =
      if (secrets.getJSONObject(name).getString("kind") == "password") Ajb1.SECRET_PASSWORD
      else Ajb1.SECRET_RECOVERY_KEY

  /** The recorded KEK for this secret and header, or a key that cannot be right. */
  private fun kekFor(secret: String, header: ByteArray): ByteArray {
    if (header.size < Ajb1.HEADER_BYTES) return wrongKey
    val salt = Ajb1.hex(header.copyOfRange(24, 40))
    val params = Ajb1.hex(header.copyOfRange(14, 24))
    val match =
        valid.firstOrNull {
          it.getString("secret") == secret &&
              it.getJSONObject("random").getString("saltHex") == salt &&
              Ajb1.hex(file(it.getString("file")).copyOfRange(14, 24)) == params
        }
    return match?.let { hex(it.getString("kekHex")) } ?: wrongKey
  }

  private class Collected(
      val records: ByteArrayOutputStream = ByteArrayOutputStream(),
      val pcm: MutableList<Pair<String, String>> = ArrayList(),
  )

  /** The production read path: precheck, unwrap, authenticate all, parse. */
  private fun read(
      bytes: ByteArray,
      secret: String,
      restoreAvailableBytes: Long? = null,
  ): Pair<Map<String, Any>, Collected> {
    val header = bytes.copyOf(minOf(bytes.size, Ajb1.HEADER_BYTES))
    val info =
        Ajb1.precheck(
            header,
            bytes.size.toLong(),
            secretKind = secretKind(secret),
            restoreAvailableBytes = restoreAvailableBytes)
    val dek = Ajb1.unwrapDek(header, kekFor(secret, header))
    val body = bytes.size.toLong() - Ajb1.HEADER_BYTES
    SegmentReader(
            ByteArrayInputStream(bytes, Ajb1.HEADER_BYTES, bytes.size), header, dek, info.segments, body)
        .authenticateAll()
    val reader =
        SegmentReader(
            ByteArrayInputStream(bytes, Ajb1.HEADER_BYTES, bytes.size), header, dek, info.segments, body)
    val collected = Collected()
    val manifest =
        Ajb1Parser(reader, info.domainSchemaVersion)
            .parse(
                object : ArchiveSink {
                  private var digest: MessageDigest? = null
                  private var id = ""

                  override fun record(record: Map<String, Any>) {
                    collected.records.write(
                        (CanonicalJson.serialize(record) + "\n").toByteArray(Charsets.UTF_8))
                  }

                  override fun recordingStart(recording: Map<String, Any>) {
                    id = recording["id"] as String
                    digest = MessageDigest.getInstance("SHA-256")
                  }

                  override fun pcm(bytes: ByteArray, offset: Int, length: Int) {
                    digest!!.update(bytes, offset, length)
                  }

                  override fun recordingEnd(recording: Map<String, Any>) {
                    collected.pcm.add(id to Ajb1.hex(digest!!.digest()))
                  }
                })
    return manifest to collected
  }

  /** Builds an archive with the production writer from a vector's inputs. */
  private fun write(vector: JSONObject): ByteArray {
    val records = file(vector.getJSONObject("expect").getString("recordsFile"))
    val counts = linkedMapOf("entry" to 0L, "recording" to 0L, "transcriptSegment" to 0L)
    String(records, Charsets.UTF_8).split('\n').filter { it.isNotEmpty() }.forEach {
      val type = JSONObject(it).getString("t")
      counts[type] = counts.getValue(type) + 1
    }
    val pcm = vector.getJSONObject("expect").optJSONArray("pcm") ?: JSONArray()
    var pcmBytes = 0L
    for (i in 0 until pcm.length()) pcmBytes += pcm.getJSONObject(i).getLong("bytes")
    val manifest =
        Ajb1Records.manifest(
            vector.getLong("createdAtMs"), 1, records.size.toLong(), sha(records), counts, pcmBytes)
    val random = vector.getJSONObject("random")
    val secret = vector.getString("secret")
    val out = ByteArrayOutputStream()
    val header =
        Ajb1.buildHeader(
            KdfParams(19_456, 2, 1),
            hex(random.getString("saltHex")),
            secretKind(secret),
            1,
            hex(random.getString("noncePrefixHex")),
            hex(random.getString("wrapNonceHex")),
            hex(vector.getString("kekHex")),
            hex(random.getString("dekHex")))
    val writer =
        SegmentWriter(out, header, hex(random.getString("dekHex")), hex(random.getString("noncePrefixHex")))
    fun section(kind: Int, body: ByteArray) {
      writer.write(ByteBuffer.allocate(12).put(kind.toByte()).put(ByteArray(3)).putLong(body.size.toLong()).array())
      writer.write(body)
    }
    section(Ajb1.SECTION_MANIFEST, CanonicalJson.serialize(manifest).toByteArray(Charsets.UTF_8))
    section(Ajb1.SECTION_RECORDS, records)
    for (i in 0 until pcm.length()) {
      val entry = pcm.getJSONObject(i)
      val source = Regex("""stream\("(.+)", (\d+)\)""").find(entry.getString("source"))!!
      val samples = stream(source.groupValues[1], source.groupValues[2].toInt())
      section(Ajb1.SECTION_RECORDING, entry.getString("id").toByteArray(Charsets.US_ASCII) + samples)
    }
    section(Ajb1.SECTION_END, ByteArray(0))
    writer.finish()
    return out.toByteArray()
  }

  @Test
  fun rebuildsEveryValidArchiveByteForByte() {
    assertEquals(4, valid.size)
    for (vector in valid) {
      val expected = file(vector.getString("file"))
      assertEquals(vector.getString("name"), vector.getString("sha256"), sha(expected))
      val built = write(vector)
      assertEquals(vector.getString("name"), vector.getString("sha256"), sha(built))
    }
  }

  @Test
  fun readsEveryValidArchiveToTheRecordedRecordsAndPcm() {
    for (vector in valid) {
      val name = vector.getString("name")
      val (manifest, collected) = read(file(vector.getString("file")), vector.getString("secret"))
      val expect = vector.getJSONObject("expect")
      assertEquals(
          name,
          CanonicalJson.serialize(plain(expect.getJSONObject("manifest"))),
          CanonicalJson.serialize(manifest))
      assertArrayEquals(name, file(vector.getJSONObject("expect").getString("recordsFile")), collected.records.toByteArray())
      val pcm = expect.optJSONArray("pcm") ?: JSONArray()
      assertEquals(name, pcm.length(), collected.pcm.size)
      for (i in 0 until pcm.length()) {
        assertEquals(name, pcm.getJSONObject(i).getString("id"), collected.pcm[i].first)
        assertEquals(name, pcm.getJSONObject(i).getString("sha256"), collected.pcm[i].second)
      }
    }
  }

  private fun base(name: String): ByteArray =
      valid.firstOrNull { it.getString("name") == name }?.let { file(it.getString("file")) }
          ?: hostile.first { it.optString("name") == "segment-splice-source" }.let {
            file(it.getString("file"))
          }

  /** Mirrors tools/ajb1-reference/lib/mutations.mjs. */
  private fun mutate(source: ByteArray, mutation: JSONObject): ByteArray {
    val file = source.copyOf()
    fun blocks(): MutableList<ByteArray> {
      val out = ArrayList<ByteArray>()
      var at = Ajb1.HEADER_BYTES
      while (at < file.size) {
        out.add(file.copyOfRange(at, minOf(file.size, at + Ajb1.BLOCK_BYTES)))
        at += Ajb1.BLOCK_BYTES
      }
      return out
    }
    fun rejoin(parts: List<ByteArray>) =
        parts.fold(file.copyOf(Ajb1.HEADER_BYTES)) { acc, part -> acc + part }
    return when (mutation.getString("op")) {
      "truncate" -> file.copyOf(mutation.getInt("length"))
      "append" -> file + hex(mutation.getString("hex"))
      "xor" -> {
        hex(mutation.getString("hex")).forEachIndexed { i, b ->
          val at = mutation.getInt("offset") + i
          file[at] = (file[at].toInt() xor b.toInt()).toByte()
        }
        file
      }
      "set" -> {
        val bytes = hex(mutation.getString("hex"))
        System.arraycopy(bytes, 0, file, mutation.getInt("offset"), bytes.size)
        file
      }
      "swapBlocks" -> {
        val parts = blocks()
        val a = mutation.getInt("a")
        val b = mutation.getInt("b")
        val tmp = parts[a]
        parts[a] = parts[b]
        parts[b] = tmp
        rejoin(parts)
      }
      "duplicateBlock" -> blocks().also { it[mutation.getInt("to")] = it[mutation.getInt("from")] }.let(::rejoin)
      "dropBlock" -> blocks().also { it.removeAt(mutation.getInt("index")) }.let(::rejoin)
      "spliceBlock" -> {
        val parts = blocks()
        val other = base(mutation.getString("fromVector"))
        val start = Ajb1.HEADER_BYTES + mutation.getInt("fromIndex") * Ajb1.BLOCK_BYTES
        parts[mutation.getInt("to")] = other.copyOfRange(start, minOf(other.size, start + Ajb1.BLOCK_BYTES))
        rejoin(parts)
      }
      else -> throw IllegalArgumentException(mutation.getString("op"))
    }
  }

  @Test
  fun rejectsEveryHostileVectorWithTheRecordedCodeAndStage() {
    var checked = 0
    for (vector in hostile) {
      val name = vector.getString("name")
      val expect = vector.getJSONObject("expect")
      if (expect.optBoolean("ok")) continue // a splice source, valid by design
      val bytes =
          if (vector.has("file")) file(vector.getString("file"))
          else {
            val source = base(vector.getString("base"))
            if (vector.isNull("mutation")) source else mutate(source, vector.getJSONObject("mutation"))
          }
      val context = vector.optJSONObject("context")
      val available =
          if (context?.optString("purpose") == "restore") context.getLong("availableBytes") else null
      try {
        read(bytes, vector.getString("secret"), available)
        fail("$name: accepted")
      } catch (failure: Ajb1.Failure) {
        assertEquals(name, "${expect.getString("code")}/${expect.getString("stage")}", "${failure.code}/${failure.stage}")
      }
      checked += 1
    }
    assertEquals(71, checked)
  }

  @Test
  fun recoveryKeysAndPasswordsMatchTheReference() {
    val words =
        BackupSecrets.Wordlist(File("../../tools/ajb1-reference/wordlists/bip39-english.txt").readBytes())
    val keys = vectors.getJSONObject("recoveryKeys")
    val encode = keys.getJSONArray("encode")
    for (i in 0 until encode.length()) {
      val case = encode.getJSONObject(i)
      assertEquals(case.getString("words"), words.encode(hex(case.getString("entropyHex"))))
    }
    val decode = keys.getJSONArray("decode")
    for (i in 0 until decode.length()) {
      val case = decode.getJSONObject(i)
      when (val result = words.decode(case.getString("input"))) {
        is BackupSecrets.Decoded.Ok -> {
          assertNull(case.optString("reason").ifEmpty { null })
          assertEquals(case.getString("name"), case.getString("entropyHex"), Ajb1.hex(result.bytes))
        }
        is BackupSecrets.Decoded.Rejected -> assertEquals(case.getString("name"), case.getString("reason"), result.reason)
      }
    }
    val passwords = vectors.getJSONArray("passwords")
    for (i in 0 until passwords.length()) {
      val case = passwords.getJSONObject(i)
      when (val result = BackupSecrets.password(case.getString("input"))) {
        is BackupSecrets.Decoded.Ok -> assertEquals(case.getString("kdfInputHex"), Ajb1.hex(result.bytes))
        is BackupSecrets.Decoded.Rejected -> assertEquals(case.getString("reason"), result.reason)
      }
    }
    val names = secrets.keys().asSequence().toList()
    for (name in names) {
      val secret = secrets.getJSONObject(name)
      val bytes =
          if (secret.getString("kind") == "password") BackupSecrets.password(secret.getString("input"))
          else words.decode(secret.getString("input"))
      assertEquals(name, secret.getString("kdfInputHex"), Ajb1.hex((bytes as BackupSecrets.Decoded.Ok).bytes))
    }
  }

  @Test
  fun canonicalJsonRejectsWhatTheProfileForbids() {
    for (bad in listOf("{\"a\":1,\"a\":2}", "{\"b\":1,\"a\":2}", "{\"a\": 1}", "{\"a\":1.0}", "{\"a\":-1}",
        "{\"a\":null}", "{\"a\":\"\\u0041\"}", "[9007199254740992]")) {
      try {
        CanonicalJson.parse(bad)
        fail("accepted $bad")
      } catch (_: CanonicalJson.Failure) {}
    }
    assertEquals("{\"a\":[1,true,\"x\"],\"b\":{}}", CanonicalJson.serialize(CanonicalJson.parse("{\"a\":[1,true,\"x\"],\"b\":{}}")))
  }
}
