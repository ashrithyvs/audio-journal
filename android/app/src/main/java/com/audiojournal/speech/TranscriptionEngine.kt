package com.audiojournal.speech

import ai.hybrid.sdk.ExecuteRequest
import ai.hybrid.sdk.ExecutionEvent
import ai.hybrid.sdk.ExecutionTarget
import ai.hybrid.sdk.NativeHybridAIClient
import ai.hybrid.sdk.PcmAudioSource
import android.content.Context
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.runBlocking
import org.json.JSONObject

/**
 * What [RecordingTranscriptions] needs from the Hybrid AI SDK. The only
 * production implementation is [SdkTranscriptionEngine]; JVM tests supply a
 * scripted one to drive lifecycle orderings deterministically.
 */
interface TranscriptionEngine : AutoCloseable {
  /** A registered source; [close] returns only after the source's own close. */
  interface Registration : AutoCloseable {
    val token: String
  }

  fun register(source: PcmAudioSource): Registration

  /** One explicit-local request; cancelling the collector cancels it. */
  fun stream(token: String, frames: Long, requestId: String, deadlineMs: Int): Flow<ExecutionEvent>

  /** Model leases still held (diagnostics only). */
  fun activeLeases(): Int
}

/**
 * The packaged public SDK surface only (AJ ADR-021/022): one
 * [NativeHybridAIClient] created with the exact pinned model configuration,
 * `registerAudioSource(source, "audio.transcribe", 1)`, and pull `stream()`
 * with an explicit `LOCAL` target. Closing this engine closes the client; it
 * is not cancellation, so [RecordingTranscriptions] cancels first.
 */
class SdkTranscriptionEngine(context: Context, pack: TranscriptionPack) : TranscriptionEngine {
  private val client = NativeHybridAIClient(context = context, modelConfiguration = pack.configuration())

  override fun register(source: PcmAudioSource): TranscriptionEngine.Registration {
    val registration =
        client.registerAudioSource(source, TranscriptionPins.CAPABILITY, TranscriptionPins.CAPABILITY_MAJOR)
    return object : TranscriptionEngine.Registration {
      override val token = registration.token

      override fun close() = registration.close()
    }
  }

  override fun stream(token: String, frames: Long, requestId: String, deadlineMs: Int): Flow<ExecutionEvent> =
      client.stream(
          ExecuteRequest(
              TranscriptionPins.CAPABILITY,
              input(token, frames),
              ExecutionTarget.LOCAL,
              majorVersion = TranscriptionPins.CAPABILITY_MAJOR.toUInt(),
              requestId = requestId,
              deadlineMs = deadlineMs))

  override fun activeLeases(): Int = runBlocking {
    client.modelProfiles().firstOrNull { it.profileId == TranscriptionPins.PROFILE_ID }?.activeLeases ?: 0
  }

  override fun close() = client.close()

  companion object {
    /** Request input: the opaque token and the source's format; no path, key, or audio. */
    fun input(token: String, frames: Long): String =
        JSONObject()
            .put(
                "source",
                JSONObject()
                    .put("token", token)
                    .put("sampleRateHz", TranscriptionPins.SAMPLE_RATE)
                    .put("channels", 1)
                    .put("sampleFormat", "s16le")
                    .put("frames", frames))
            .toString()
  }
}
