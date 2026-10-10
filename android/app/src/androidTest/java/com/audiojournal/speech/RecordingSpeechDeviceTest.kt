package com.audiojournal.speech

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.audiojournal.recording.Ajr1
import com.audiojournal.recording.Ajr1Reader
import com.audiojournal.recording.Ajr1Writer
import android.os.ParcelFileDescriptor
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.SecureRandom
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Real speech through the production final-pass path on the device (LLD §6):
 * PCM sealed into AJR1, decrypted window by window by [RecordingPass], and
 * decoded by the bundled whisper.cpp model. The audio is whisper.cpp's
 * public-domain `jfk.wav` sample, which `e2e/aj1/speech.mjs` pushes to
 * [SAMPLE] (no audio is committed); the test reads it with the
 * instrumentation's shell access. Without it the test is skipped, never
 * passed.
 */
@RunWith(AndroidJUnit4::class)
class RecordingSpeechDeviceTest {
  private val context = InstrumentationRegistry.getInstrumentation().targetContext
  private val id = "rec_" + "s".repeat(26)
  private lateinit var dir: File

  @Before
  fun setUp() {
    dir = File(context.cacheDir, "aj1-speech-test").apply { deleteRecursively() }
  }

  @After
  fun tearDown() {
    dir.deleteRecursively()
  }

  @Test
  fun aSealedRecordingTranscribesInOneWindowAndAcrossACut() {
    val wav = shellRead(SAMPLE)
    assumeTrue("push jfk.wav to $SAMPLE first", wav.isNotEmpty())
    val pcm = pcm16Mono16k(wav)
    val root = ByteArray(32).also { SecureRandom().nextBytes(it) }
    val file = File(dir, "$id.ajr1")
    Ajr1Writer.create(file, id, root).use { writer ->
      var offset = 0
      while (offset < pcm.size) {
        val end = minOf(offset + CHUNK_BYTES, pcm.size)
        writer.append(pcm.copyOfRange(offset, end))
        offset = end
      }
    }
    val durationMs = pcm.size / 32L

    val model = WhisperNative.loadModel(SpeechModels.file(context, SpeechModels.DEFAULT).absolutePath)
    assertTrue("model", model != 0L)
    val state = WhisperNative.newState(model)
    val cancel = WhisperNative.newCancel()
    try {
      // The production 5-minute window: one pass over the whole recording.
      val whole = words(transcribe(file, root, model, state, cancel, RecordingPass.WINDOW_MS, durationMs))
      assertTrue(whole, whole.contains("ask not what your country can do for you"))
      assertTrue(whole, whole.contains("what you can do for your country"))

      // A 6 s window forces a cut inside the speech; it moves to a pause.
      val cut = words(transcribe(file, root, model, state, cancel, 6_000, durationMs))
      for (word in listOf("americans", "ask", "country", "for", "you")) {
        assertTrue("$word in: $cut", cut.contains(word))
      }
    } finally {
      WhisperNative.freeCancel(cancel)
      WhisperNative.freeState(state)
      WhisperNative.freeModel(model)
    }
  }

  private fun transcribe(
      file: File,
      root: ByteArray,
      model: Long,
      state: Long,
      cancel: Long,
      windowMs: Long,
      durationMs: Long,
  ): List<RecordingPass.Segment> {
    val segments =
        Ajr1Reader(Ajr1.FileSource(RandomAccessFile(file, "r")), root, id).use { reader ->
          RecordingPass(reader, windowMs = windowMs).run { _, samples ->
            val raw =
                JSONObject(
                    WhisperNative.transcribe(
                        model,
                        state,
                        samples,
                        4,
                        cancel,
                        object : SegmentListener {
                          override fun onSegment(t0Ms: Long, t1Ms: Long, text: String) = Unit
                        }))
            assertEquals("ok", raw.getString("status"))
            val list = raw.getJSONArray("segments")
            (0 until list.length()).map {
              val segment = list.getJSONObject(it)
              RecordingPass.Segment(
                  segment.getLong("t0Ms"), segment.getLong("t1Ms"), segment.getString("text"))
            }
          }
        }
    checkNotNull(segments)
    var previous = 0L
    for (segment in segments) {
      assertTrue(segment.t0Ms >= previous && segment.t1Ms >= segment.t0Ms)
      assertTrue(segment.t1Ms <= durationMs + 1_000)
      previous = segment.t0Ms
    }
    return segments
  }

  private fun words(segments: List<RecordingPass.Segment>): String =
      segments
          .joinToString(" ") { it.text }
          .lowercase()
          .replace(Regex("[^a-z]+"), " ")
          .trim()

  /** A file only the shell can read; empty when it does not exist. */
  private fun shellRead(path: String): ByteArray {
    val output =
        InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand("cat $path")
    return ParcelFileDescriptor.AutoCloseInputStream(output).use { it.readBytes() }
  }

  /** The `data` chunk of a 16 kHz, mono, 16-bit PCM WAV file. */
  private fun pcm16Mono16k(bytes: ByteArray): ByteArray {
    val le = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
    assertEquals("RIFF", String(bytes, 0, 4, Charsets.US_ASCII))
    assertEquals("WAVE", String(bytes, 8, 4, Charsets.US_ASCII))
    var at = 12
    var format = false
    while (at + 8 <= bytes.size) {
      val name = String(bytes, at, 4, Charsets.US_ASCII)
      val size = le.getInt(at + 4)
      val body = at + 8
      when (name) {
        "fmt " -> {
          assertEquals(1, le.getShort(body).toInt()) // PCM
          assertEquals(1, le.getShort(body + 2).toInt()) // mono
          assertEquals(16_000, le.getInt(body + 4))
          assertEquals(16, le.getShort(body + 14).toInt())
          format = true
        }
        "data" -> {
          assertTrue("fmt before data", format)
          return bytes.copyOfRange(body, minOf(body + size, bytes.size))
        }
      }
      at = body + size + (size and 1)
    }
    throw AssertionError("no data chunk")
  }

  private companion object {
    const val CHUNK_BYTES = 32_000 // 1 s, like the recorder's sealed chunks
    const val SAMPLE = "/data/local/tmp/aj1-speech/jfk.wav"
  }
}
