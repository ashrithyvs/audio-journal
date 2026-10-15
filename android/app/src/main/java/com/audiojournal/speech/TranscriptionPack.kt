package com.audiojournal.speech

import ai.hybrid.sdk.ModelConfigurationDocument
import ai.hybrid.sdk.ModelRuntimeConfiguration
import android.content.Context
import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import org.json.JSONObject

/**
 * Deploys the SDK-defined transcription model pack (AJ ADR-022). The build
 * copies the exact accepted bytes into APK assets; here they are copied once
 * into app-private no-backup storage, and every file is checked against
 * [TranscriptionPins] before the SDK sees it. Audio Journal chooses no model
 * and downloads nothing; the SDK checks the artifact again when it loads it.
 */
class TranscriptionPack(
    private val open: (String) -> InputStream,
    private val directory: File,
    /** Model copies left by the removed app-owned engine (ADR-016) on upgraded installs. */
    private val legacyModels: File? = null,
) {
  constructor(context: Context) :
      this(
          { name -> context.assets.open("$ASSET_DIR/$name") },
          File(context.noBackupFilesDir, DIRECTORY),
          File(context.noBackupFilesDir, LEGACY_MODEL_DIRECTORY))

  /** A pack file is missing or differs from its pin. */
  class Invalid : Exception("MODEL_PACK_INVALID")

  @Volatile private var configuration: ModelRuntimeConfiguration? = null

  /** The verified creation-time configuration; throws [Invalid] (fail closed). */
  @Synchronized
  fun configuration(): ModelRuntimeConfiguration {
    configuration?.let { return it }
    // Audio Journal no longer owns a model runtime: drop the old engine's copies.
    legacyModels?.deleteRecursively()
    val profile = document(PROFILE_ASSET, TranscriptionPins.PROFILE_SHA256)
    val pack = document(PACKAGE_ASSET, TranscriptionPins.PACKAGE_SHA256)
    checkProfile(JSONObject(String(profile, Charsets.UTF_8)))
    checkPackage(JSONObject(String(pack, Charsets.UTF_8)))
    installModel()
    return ModelRuntimeConfiguration(
            modelRoot = directory.absolutePath,
            capabilityPackages = listOf(ModelConfigurationDocument(pack, TranscriptionPins.PACKAGE_SHA256)),
            modelProfiles = listOf(ModelConfigurationDocument(profile, TranscriptionPins.PROFILE_SHA256)),
        )
        .also { configuration = it }
  }

  private fun document(name: String, sha256: String): ByteArray {
    val bytes = open(name).use { it.readBytes() }
    if (bytes.size > MAX_DOCUMENT_BYTES || sha256(bytes) != sha256) throw Invalid()
    return bytes
  }

  /** The pinned identity the documents must state, beyond their digests. */
  private fun checkProfile(json: JSONObject) {
    val provider = json.getJSONObject("provider")
    val artifact = json.getJSONObject("model").getJSONObject("artifact")
    val audio = json.getJSONObject("transcription")
    val ok =
        json.getString("profileId") == TranscriptionPins.PROFILE_ID &&
            json.getString("profileVersion") == TranscriptionPins.PROFILE_VERSION &&
            json.getString("target") == "local" &&
            provider.getString("id") == TranscriptionPins.PROVIDER_ID &&
            provider.getString("revision") == TranscriptionPins.PROVIDER_REVISION &&
            artifact.getString("file") == TranscriptionPins.MODEL_FILE &&
            artifact.getString("sha256") == TranscriptionPins.MODEL_SHA256 &&
            artifact.getLong("bytes") == TranscriptionPins.MODEL_BYTES &&
            audio.getInt("sampleRateHz") == TranscriptionPins.SAMPLE_RATE &&
            audio.getInt("channels") == 1 &&
            audio.getString("sampleFormat") == "s16le" &&
            audio.getLong("maxAudioMs") == TranscriptionPins.MAX_AUDIO_MS &&
            audio.getString("decodeConfigRevision") == TranscriptionPins.DECODE_CONFIG_REVISION
    if (!ok) throw Invalid()
  }

  private fun checkPackage(json: JSONObject) {
    val capability = json.getJSONObject("capability")
    val ok =
        json.getString("packageId") == TranscriptionPins.PACKAGE_ID &&
            json.getString("packageRevision") == TranscriptionPins.PACKAGE_REVISION &&
            capability.getString("id") == TranscriptionPins.CAPABILITY &&
            capability.getString("version").substringBefore('.') ==
                TranscriptionPins.CAPABILITY_MAJOR.toString()
    if (!ok) throw Invalid()
  }

  /**
   * Copies the artifact once per app install and verifies its size and
   * SHA-256 in every process before first use; a mismatch is replaced from
   * the APK, and a mismatching APK copy fails closed.
   */
  private fun installModel() {
    directory.mkdirs()
    val target = File(directory, TranscriptionPins.MODEL_FILE)
    if (verified(target)) return
    val temp = File(directory, "${TranscriptionPins.MODEL_FILE}.tmp")
    try {
      open(TranscriptionPins.MODEL_FILE).use { input -> temp.outputStream().use { input.copyTo(it) } }
      if (!verified(temp) || !temp.renameTo(target)) throw Invalid()
    } finally {
      temp.delete()
    }
  }

  private fun verified(file: File): Boolean =
      file.isFile &&
          file.length() == TranscriptionPins.MODEL_BYTES &&
          file.inputStream().use { sha256(it) } == TranscriptionPins.MODEL_SHA256

  companion object {
    const val ASSET_DIR = "hybrid-ai-transcription"
    const val DIRECTORY = "hybrid-ai-transcription"
    const val LEGACY_MODEL_DIRECTORY = "speech-models"
    const val PROFILE_ASSET = "sdk.whisper.tiny-en-q5-1.profile.json"
    const val PACKAGE_ASSET = "audio-transcribe.tiny-en.package.json"
    private const val MAX_DOCUMENT_BYTES = 256 * 1024

    fun sha256(bytes: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(bytes))

    fun sha256(input: InputStream): String {
      val digest = MessageDigest.getInstance("SHA-256")
      val buffer = ByteArray(1 shl 20)
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        digest.update(buffer, 0, read)
      }
      return hex(digest.digest())
    }

    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
  }
}
