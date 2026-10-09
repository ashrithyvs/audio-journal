package com.audiojournal

import android.content.Context
import java.io.File

/**
 * Provisions the Hybrid AI SDK's packaged local models for this app (SDK
 * ADR-019: models are application-provided). The AAR contributes the verified
 * manifests and artifacts as APK assets; they are copied once into app-private
 * no-backup storage, where the SDK verifies each SHA-256 before loading.
 */
object LocalModelAssets {
  private val files = listOf(
      "text.complete.json", "stories260K.gguf", "vector.embed.json", "embed-v1.onnx")

  /** Returns the model directory, or null when the assets are not packaged. */
  fun install(context: Context): String? {
    val directory = File(context.noBackupFilesDir, "hybrid-ai-models")
    return try {
      directory.mkdirs()
      // Re-copy after every app install or update; the SDK checks SHA-256 anyway.
      val stamp = context.packageManager
          .getPackageInfo(context.packageName, 0).lastUpdateTime.toString()
      val marker = File(directory, ".installed")
      if (marker.isFile && marker.readText() == stamp && files.all { File(directory, it).isFile }) {
        return directory.absolutePath
      }
      for (name in files) {
        val temp = File(directory, "$name.tmp")
        context.assets.open(name).use { input -> temp.outputStream().use { input.copyTo(it) } }
        if (!temp.renameTo(File(directory, name))) throw IllegalStateException("rename failed")
      }
      marker.writeText(stamp)
      directory.absolutePath
    } catch (_: Exception) {
      null
    }
  }
}
