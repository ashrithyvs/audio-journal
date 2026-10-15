package com.audiojournal.speech

import ai.hybrid.sdk.NativeHybridAIClient
import android.os.ParcelFileDescriptor
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.audiojournal.recording.Ajr1
import com.audiojournal.recording.Ajr1Reader
import com.audiojournal.recording.Ajr1Writer
import java.io.ByteArrayInputStream
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.BeforeClass
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.MethodSorters

/**
 * AJ-RI-2 on device through the packaged Hybrid AI SDK (`REAL_MODEL_PUBLIC_SDK`):
 * the production adapter ([Ajr1PcmSource]), orchestration
 * ([RecordingTranscriptions]), model pack ([TranscriptionPack], from this APK's
 * assets), and [SdkTranscriptionEngine] over real AJR1 recordings sealed from
 * the pinned public LibriSpeech clips of the RI-2 corpus. The host script
 * pushes the clips to `/data/local/tmp/aj-ri2/corpus`; without them the test
 * is skipped, never passed. Transcripts of this public speech go only to
 * `files/aj-ri2-results` for host WER scoring; nothing is logged.
 *
 * Process death and the vault-backed source are covered by the UI journey
 * (`e2e/aj-ri2/transcription-journey.mjs`).
 */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class TranscriptionDurabilityDeviceTest {
  companion object {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private const val INPUT = "/data/local/tmp/aj-ri2/corpus"
    private val root = ByteArray(32).also { SecureRandom().nextBytes(it) }
    private lateinit var dir: File
    private lateinit var results: File
    private val recordings = HashMap<String, File>()
    private var manifest = JSONArray()

    @BeforeClass
    @JvmStatic
    fun seal() {
      dir = File(context.cacheDir, "aj-ri2-device").apply { deleteRecursively(); mkdirs() }
      results = File(context.filesDir, "aj-ri2-results").apply { deleteRecursively(); mkdirs() }
      val text = String(shellRead("$INPUT/manifest.json"))
      if (text.isEmpty()) return
      manifest = JSONObject(text).getJSONArray("clips")
      for (i in 0 until manifest.length()) {
        val id = manifest.getJSONObject(i).getString("id")
        val wav = shellRead("$INPUT/$id.wav")
        check(sha256(wav) == manifest.getJSONObject(i).getString("wavSha256")) { "clip hash $id" }
        recordings[id] = seal(id, pcm16Mono16k(wav))
      }
    }

    @AfterClass
    @JvmStatic
    fun cleanUp() {
      dir.deleteRecursively()
    }

    /** Seals PCM into AJR1 in 1 s frames, as the recorder does. */
    private fun seal(id: String, pcm: ByteArray): File {
      val file = File(dir, "$id.ajr")
      Ajr1Writer.create(file, recordingId(id), root, syncEachFrame = false).use { writer ->
        var at = 0
        while (at < pcm.size) {
          val end = minOf(at + Ajr1.MAX_CHUNK_BYTES, pcm.size)
          writer.append(pcm.copyOfRange(at, end))
          at = end
        }
      }
      return file
    }

    /** A valid recording ID per clip (26 base32 characters after `rec_`). */
    fun recordingId(id: String): String {
      val alphabet = "0123456789abcdefghjkmnpqrstvwxyz"
      val digest = MessageDigest.getInstance("SHA-256").digest(id.toByteArray())
      return "rec_" + (0 until 26).map { alphabet[(digest[it].toInt() and 0xff) % 32] }.joinToString("")
    }

    fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun shellRead(path: String): ByteArray {
      val output = instrumentation.uiAutomation.executeShellCommand("cat $path")
      return ParcelFileDescriptor.AutoCloseInputStream(output).use { it.readBytes() }
    }

    private fun pcm16Mono16k(bytes: ByteArray): ByteArray {
      val le = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
      var at = 12
      while (at + 8 <= bytes.size) {
        val name = String(bytes, at, 4, Charsets.US_ASCII)
        val size = le.getInt(at + 4)
        if (name == "fmt ") {
          check(le.getShort(at + 8).toInt() == 1 && le.getShort(at + 10).toInt() == 1 &&
              le.getInt(at + 12) == 16_000 && le.getShort(at + 22).toInt() == 16) { "not 16 kHz mono s16le" }
        } else if (name == "data") {
          return bytes.copyOfRange(at + 8, at + 8 + size)
        }
        at += 8 + size + (size and 1)
      }
      error("no data chunk")
    }

    fun procKib(field: String): Long =
        File("/proc/self/status").readLines().firstOrNull { it.startsWith(field) }
            ?.substringAfter(':')?.trim()?.substringBefore(' ')?.toLong() ?: -1

    fun resetPeak() = runCatching { File("/proc/self/clear_refs").writeText("5") }.isSuccess

    fun record(name: String, json: JSONObject) = File(results, "$name.json").writeText(json.toString(2))
  }

  private var lastSource: Ajr1PcmSource? = null
  /** Stands in for the vault's unlock epoch: a lock refuses requests until it rises. */
  private var epoch = 1L

  private fun service(
      pack: TranscriptionPack = TranscriptionPack(context),
      deadlineMs: Int = RecordingTranscriptions.DEADLINE_MS,
      file: (String) -> File = { recordings.getValue(it) },
  ) =
      RecordingTranscriptions(
          engineFactory = { SdkTranscriptionEngine(context, pack) },
          openSource = { recId ->
            val id = recordings.keys.first { recordingId(it) == recId }
            Ajr1PcmSource(Ajr1Reader(Ajr1.FileSource(RandomAccessFile(file(id), "r")), root, recId))
                .also { lastSource = it }
          },
          isCapturing = { false },
          unlockEpoch = { epoch },
          deadlineMs = deadlineMs,
      )

  private fun requireCorpus() = assumeTrue("push the corpus to $INPUT first", recordings.isNotEmpty())

  private fun fileSha(id: String) = sha256(recordings.getValue(id).readBytes())

  private fun steps(t: RecordingTranscriptions): List<String> {
    val recent = t.diagnostics().getJSONArray("recent")
    val list = recent.getJSONObject(recent.length() - 1).getJSONArray("steps")
    return (0 until list.length()).map { list.getString(it) }
  }

  private fun names(steps: List<String>) = steps.map { it.substringBefore('@') }

  /**
   * The SDK operation's own `cancelled` terminal was observed after the cancel,
   * its producer ended, and its model lease was released, all before the
   * registration (and with it the source) was closed.
   */
  private fun assertCancelOrder(steps: List<String>) {
    assertEquals(
        steps.toString(),
        listOf("registered", "cancelRequested", "terminal:cancelled", "producerEnded", "leaseReleased",
            "registrationClosed", "sourceCloses:1"),
        names(steps))
    val times = steps.map { it.substringAfter('@').toLong() }
    assertEquals(steps.toString(), times.sorted(), times)
  }

  /**
   * Milliseconds until the SDK reports no active model lease (bounded). After a
   * cancel the inference worker leaves at its next abort point, slightly after
   * the request's terminal; a lease that never ends fails the test.
   */
  private fun leaseReleasedWithinMs(t: RecordingTranscriptions, boundMs: Long = 5_000): Long {
    val started = System.nanoTime()
    while (t.diagnostics().getInt("activeLeases") != 0) {
      val elapsed = (System.nanoTime() - started) / 1_000_000
      assertTrue("model lease still held after $elapsed ms", elapsed < boundMs)
      Thread.sleep(5)
    }
    return (System.nanoTime() - started) / 1_000_000
  }

  private fun at(steps: List<String>, name: String) =
      steps.first { it.substringBefore('@') == name }.substringAfter('@').toLong()

  /** The APK carries exactly the accepted profile, provider, and artifact. */
  @Test
  fun t01_packagedProfileIsTheAcceptedIdentity() = runBlocking {
    val pack = TranscriptionPack(context)
    NativeHybridAIClient(context = context, modelConfiguration = pack.configuration()).use { client ->
      val profile = client.modelProfiles().single()
      assertEquals(TranscriptionPins.PROFILE_ID, profile.profileId)
      assertEquals(TranscriptionPins.PROVIDER_REVISION, profile.providerRevision)
      assertEquals(TranscriptionPins.MODEL_SHA256, profile.artifactSha256)
      assertTrue(profile.providerAvailable)
      val model = File(File(context.noBackupFilesDir, TranscriptionPack.DIRECTORY), TranscriptionPins.MODEL_FILE)
      assertEquals(TranscriptionPins.MODEL_BYTES, model.length())
      record("t01-identity", JSONObject().put("profileId", profile.profileId)
          .put("providerRevision", profile.providerRevision).put("artifactSha256", profile.artifactSha256)
          .put("modelBytes", model.length()).put("modelFileSha256", model.inputStream().use { TranscriptionPack.sha256(it) }))
    }
  }

  /** Real speech through AJR1 -> SDK: every pinned clip once, with timing and peak memory. */
  @Test
  fun t02_sealedRecordingsTranscribe() {
    requireCorpus()
    val t = service()
    val clips = JSONArray()
    val baseline = procKib("VmRSS:")
    try {
      for (i in 0 until manifest.length()) {
        val clip = manifest.getJSONObject(i)
        val id = clip.getString("id")
        val before = fileSha(id)
        val peakReset = resetPeak()
        val result = t.transcribe("acc-$id", recordingId(id))
        assertEquals("$id: ${result.failure}", "ok", result.status)
        assertEquals(clip.getLong("frames") * 1_000 / 16_000, result.audioMs)
        assertEquals("$id unchanged", before, fileSha(id))
        assertEquals("$id source closed once", 1, lastSource!!.closeCount)
        assertEquals(0, t.activeCount())
        assertEquals("no lease after terminal", 0, t.diagnostics().getInt("activeLeases"))
        clips.put(JSONObject().put("id", id).put("audioMs", result.audioMs).put("totalMs", result.totalMs)
            .put("firstPartialMs", result.firstPartialMs).put("rtf", result.totalMs.toDouble() / result.audioMs)
            .put("segments", result.segments.size).put("peakRssKiB", procKib("VmHWM:")).put("peakReset", peakReset)
            .put("text", result.segments.joinToString(" ") { it.text }))
      }
    } finally {
      t.close()
    }
    record("t02-accuracy", JSONObject().put("evidenceClass", "REAL_MODEL_PUBLIC_SDK")
        .put("modelId", TranscriptionPins.MODEL_ID).put("baselineRssKiB", baseline).put("clips", clips))
  }

  /** Provider failure (deadline) keeps the recording; a retry completes. */
  @Test
  fun t03_providerFailureThenRetry() {
    requireCorpus()
    val id = "ls-61-180s"
    val before = fileSha(id)
    val failing = service(deadlineMs = 1_500)
    val failed = try { failing.transcribe("deadline", recordingId(id)) } finally { failing.close() }
    assertEquals("failed", failed.status)
    assertEquals("DEADLINE_EXCEEDED", failed.failure)
    assertTrue(failed.segments.isEmpty())
    assertEquals(1, lastSource!!.closeCount)
    assertEquals(before, fileSha(id))
    val t = service()
    try {
      val retried = t.transcribe("deadline-retry", recordingId(id))
      assertEquals("ok", retried.status)
      record("t03-provider-failure", JSONObject().put("failure", failed.failure).put("failedAfterMs", failed.totalMs)
          .put("retry", retried.status).put("retrySegments", retried.segments.size))
    } finally {
      t.close()
    }
  }

  /** A model artifact that differs from its pin fails closed; the real pack then works. */
  @Test
  fun t04_modelPackFailureThenRetry() {
    requireCorpus()
    val id = "ls-121-30s"
    val tamperedDir = File(context.cacheDir, "aj-ri2-tampered-pack").apply { deleteRecursively(); mkdirs() }
    val tampered =
        TranscriptionPack(
            { name ->
              val bytes = context.assets.open("${TranscriptionPack.ASSET_DIR}/$name").use { it.readBytes() }
              if (name == TranscriptionPins.MODEL_FILE) bytes[bytes.size / 2] = (bytes[bytes.size / 2].toInt() xor 1).toByte()
              ByteArrayInputStream(bytes)
            },
            tamperedDir)
    val failing = service(pack = tampered)
    val failed = try { failing.transcribe("bad-pack", recordingId(id)) } finally { failing.close() }
    assertEquals("MODEL_PACK_INVALID", failed.failure)
    assertTrue("the source key was released", lastSource!!.isClosed)
    assertTrue("no tampered artifact is installed", tamperedDir.listFiles().isNullOrEmpty())
    tamperedDir.deleteRecursively()
    val t = service()
    try {
      assertEquals("ok", t.transcribe("pack-retry", recordingId(id)).status)
    } finally {
      t.close()
    }
    record("t04-model-failure", JSONObject().put("failure", failed.failure))
  }

  /** User cancel mid-inference: cancelled, released once, no lease, retry works. */
  @Test
  fun t05_userCancelThenRetry() {
    requireCorpus()
    val id = "ls-61-180s"
    val before = fileSha(id)
    val t = service()
    val worker = Executors.newSingleThreadExecutor()
    try {
      val pending = worker.submit<RecordingTranscriptions.Result> { t.transcribe("cancel", recordingId(id)) }
      Thread.sleep(5_000)
      assertEquals("still running at cancel", 1, t.activeCount())
      val cancelledAt = System.nanoTime()
      t.cancel("cancel")
      val result = pending.get(30, TimeUnit.SECONDS)
      val cancelMs = (System.nanoTime() - cancelledAt) / 1_000_000
      assertEquals("cancelled", result.status)
      assertTrue(result.segments.isEmpty())
      assertEquals(1, lastSource!!.closeCount)
      val leaseMs = leaseReleasedWithinMs(t)
      val steps = steps(t)
      assertCancelOrder(steps)
      assertEquals(before, fileSha(id))
      assertEquals("ok", t.transcribe("cancel-retry", recordingId("ls-121-30s")).status)
      assertEquals(0, t.diagnostics().getInt("activeLeases"))
      record("t05-user-cancel", JSONObject().put("cancelToEndMs", cancelMs).put("leaseReleasedAfterEndMs", leaseMs)
          .put("steps", JSONArray(steps)))
    } finally {
      worker.shutdownNow()
      t.close()
    }
  }

  /**
   * App lock mid-inference, exactly as the vault calls it: cancel, wait for the
   * terminal (bounded), then close the registration. The client survives.
   */
  @Test
  fun t06_appLockCancelsBeforeClose() {
    requireCorpus()
    val id = "ls-260-180s"
    val before = fileSha(id)
    val t = service()
    val worker = Executors.newSingleThreadExecutor()
    try {
      val pending = worker.submit<RecordingTranscriptions.Result> { t.transcribe("lock", recordingId(id)) }
      Thread.sleep(5_000)
      assertEquals(1, t.activeCount())
      val lockedAt = System.nanoTime()
      assertEquals(1, t.cancelAll())
      val lockMs = (System.nanoTime() - lockedAt) / 1_000_000
      // cancelAll returned only after the request ended and its source was released.
      assertEquals(0, t.activeCount())
      assertTrue(lastSource!!.isClosed)
      assertEquals(1, lastSource!!.closeCount)
      assertTrue("within the bound ($lockMs ms)", lockMs < RecordingTranscriptions.CANCEL_WAIT_MS)
      val leaseMs = leaseReleasedWithinMs(t)
      assertEquals("cancelled", pending.get(5, TimeUnit.SECONDS).status)
      val steps = steps(t)
      val order = names(steps)
      assertTrue(steps.toString(), !order.contains("cancelWaitExceeded"))
      assertTrue(steps.toString(), !order.contains("leaseWaitExceeded"))
      assertCancelOrder(steps)
      assertEquals(before, fileSha(id))
      // Locked: nothing starts until the vault is unlocked again.
      assertEquals("LOCKED", t.transcribe("while-locked", recordingId(id)).failure)
      epoch += 1 // unlock
      // After unlock the same client transcribes again.
      assertEquals("ok", t.transcribe("lock-retry", recordingId(id)).status)
      assertEquals(0, t.diagnostics().getInt("activeLeases"))
      record("t06-app-lock", JSONObject().put("lockReturnedMs", lockMs).put("leaseReleasedAfterLockMs", leaseMs)
          .put("steps", JSONArray(steps)))
    } finally {
      worker.shutdownNow()
      t.close()
    }
  }

  /** An authentication failure in the recording is reported as damage; nothing is stored. */
  @Test
  fun t07_damagedRecordingIsTyped() {
    requireCorpus()
    val id = "ls-237-30s"
    val copy = File(dir, "damaged.ajr")
    recordings.getValue(id).copyTo(copy, overwrite = true)
    RandomAccessFile(copy, "rw").use { raf ->
      val at = (Ajr1.HEADER_BYTES + 10 * (Ajr1.FRAME_HEADER_BYTES + Ajr1.MAX_CHUNK_BYTES + Ajr1.TAG_BYTES) +
          Ajr1.FRAME_HEADER_BYTES + 100).toLong()
      raf.seek(at)
      val byte = raf.read()
      raf.seek(at)
      raf.write(byte xor 1)
    }
    val t = service(file = { copy })
    try {
      val result = t.transcribe("damaged", recordingId(id))
      assertEquals("failed", result.status)
      assertEquals("SOURCE_DAMAGED", result.failure)
      assertTrue(result.segments.isEmpty())
      assertEquals(1, lastSource!!.closeCount)
      record("t07-damaged", JSONObject().put("failure", result.failure))
    } finally {
      t.close()
      copy.delete()
    }
  }

  /**
   * No plaintext audio or transcript file exists in app storage: every file is
   * an AJR1 recording, the encrypted journal store, the verified model pack, an
   * unchanged SDK asset copy, an ART cache, or this test's own public-corpus
   * results. Copies of the removed app-owned engine's models are gone.
   */
  @Test
  fun t08_noPlaintextAudioOrTranscriptFiles() {
    requireCorpus()
    TranscriptionPack(context).configuration() // what the app runs before its first request
    assertTrue(
        "legacy app-owned models removed",
        !File(context.noBackupFilesDir, TranscriptionPack.LEGACY_MODEL_DIRECTORY).exists())
    val data = context.dataDir.canonicalPath
    val classes = JSONObject()
    val suspicious = ArrayList<String>()
    fun head(file: File, n: Int) = file.inputStream().use { input -> ByteArray(n).also { input.read(it) } }
    for (top in listOf(context.cacheDir, context.filesDir, context.noBackupFilesDir, context.codeCacheDir)) {
      top.walkTopDown().filter { it.isFile }.forEach { file ->
        val path = file.canonicalPath.removePrefix(data)
        val magic = head(file, 16)
        val kind =
            when {
              path.startsWith("/files/aj-ri2-results/") -> "test-results"
              path.startsWith("/no_backup/${TranscriptionPack.DIRECTORY}/") ->
                  if (file.name == TranscriptionPins.MODEL_FILE &&
                      file.inputStream().use { TranscriptionPack.sha256(it) } == TranscriptionPins.MODEL_SHA256)
                      "model-pack"
                  else "UNEXPECTED"
              file.extension == "ajr" ->
                  if (String(magic, 0, 4, Charsets.US_ASCII) == "AJR1") "ajr1" else "UNEXPECTED"
              path.startsWith("/no_backup/journal/") ->
                  if (String(magic, Charsets.US_ASCII).startsWith("SQLite format 3")) "UNEXPECTED" else "sqlcipher"
              path == "/no_backup/hybrid-ai-models/.installed" -> "sdk-asset-stamp"
              path == "/no_backup/vault/vault.bin" -> "vault"
              // The SDK's Private AI Node pairing store (node keys/pins), from earlier pairing.
              path.startsWith("/no_backup/hybrid-ai-pairing/") -> "sdk-pairing"
              path == "/files/profileInstalled" -> "art"
              path.startsWith("/no_backup/hybrid-ai-models/") ->
                  if (context.assets.open(file.name).use { TranscriptionPack.sha256(it) } ==
                      file.inputStream().use { TranscriptionPack.sha256(it) })
                      "sdk-asset"
                  else "UNEXPECTED"
              path.startsWith("/cache/oat_primary/") || path.startsWith("/code_cache/") -> "art"
              file.length() == 0L -> "empty"
              else -> "UNEXPECTED"
            }
        if (String(magic, 0, 4, Charsets.US_ASCII) == "RIFF") suspicious += "$path (RIFF)"
        if (kind == "UNEXPECTED") suspicious += path
        classes.put(kind, classes.optInt(kind) + 1)
      }
    }
    record("t08-temp-files", JSONObject().put("classes", classes).put("suspicious", JSONArray(suspicious)))
    assertEquals(emptyList<String>(), suspicious)
  }
}
