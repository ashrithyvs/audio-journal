package com.audiojournal.speech

import java.io.ByteArrayInputStream
import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test

/**
 * The model pack deploys exactly the accepted bytes and fails closed otherwise
 * (AJ ADR-022). Uses the staged package directory on this machine
 * (`Ash/hybrid-ai-packages/ri2-a54266a`); skipped, never passed, without it.
 */
class TranscriptionPackTest {
  private val packDir = File("../../../hybrid-ai-packages/ri2-a54266a").canonicalFile
  private lateinit var dir: File

  @Before
  fun setUp() {
    assumeTrue("staged pack at $packDir", packDir.isDirectory)
    dir = Files.createTempDirectory("aj-ri2-pack").toFile()
  }

  @After
  fun tearDown() {
    if (::dir.isInitialized) dir.deleteRecursively()
  }

  private fun pack(tamper: String? = null) =
      TranscriptionPack(
          { name ->
            val bytes = File(packDir, name).readBytes()
            if (name == tamper) bytes[bytes.size / 2] = (bytes[bytes.size / 2].toInt() xor 1).toByte()
            ByteArrayInputStream(bytes)
          },
          File(dir, "pack"),
          File(dir, "speech-models"))

  @Test
  fun installsThePinnedPackAndRemovesTheOldEngineModels() {
    val legacy = File(dir, "speech-models").apply { mkdirs() }
    File(legacy, "ggml-base.en-q5_1.bin").writeText("old engine model")
    val configuration = pack().configuration()
    assertEquals(File(dir, "pack").absolutePath, configuration.modelRoot)
    assertEquals(listOf(TranscriptionPins.PROFILE_SHA256), configuration.modelProfiles.map { it.sha256 })
    assertEquals(listOf(TranscriptionPins.PACKAGE_SHA256), configuration.capabilityPackages.map { it.sha256 })
    val model = File(File(dir, "pack"), TranscriptionPins.MODEL_FILE)
    assertEquals(TranscriptionPins.MODEL_BYTES, model.length())
    assertEquals(TranscriptionPins.MODEL_SHA256, model.inputStream().use { TranscriptionPack.sha256(it) })
    assertFalse("legacy app-owned models removed", legacy.exists())
    assertEquals(listOf(TranscriptionPins.MODEL_FILE), File(dir, "pack").list()!!.toList())
  }

  @Test
  fun anyDifferentByteFailsClosed() {
    for (name in listOf(TranscriptionPins.MODEL_FILE, TranscriptionPack.PROFILE_ASSET, TranscriptionPack.PACKAGE_ASSET)) {
      File(dir, "pack").deleteRecursively()
      try {
        pack(tamper = name).configuration()
        throw AssertionError("$name accepted")
      } catch (_: TranscriptionPack.Invalid) {
      }
      val left = File(dir, "pack").list().orEmpty().toList()
      assertTrue("$name left no installed model: $left", TranscriptionPins.MODEL_FILE !in left)
    }
  }

  @Test
  fun aDamagedInstalledCopyIsReplacedFromTheApk() {
    pack().configuration()
    val model = File(File(dir, "pack"), TranscriptionPins.MODEL_FILE)
    model.writeText("damaged")
    pack().configuration()
    assertEquals(TranscriptionPins.MODEL_SHA256, model.inputStream().use { TranscriptionPack.sha256(it) })
  }
}
