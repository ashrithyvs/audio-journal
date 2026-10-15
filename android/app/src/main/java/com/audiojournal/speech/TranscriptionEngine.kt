package com.audiojournal.speech

import ai.hybrid.sdk.ExecuteRequest
import ai.hybrid.sdk.ExecutionTarget
import ai.hybrid.sdk.NativeExecutionOperation
import ai.hybrid.sdk.NativeHybridAIClient
import ai.hybrid.sdk.PcmAudioSource
import ai.hybrid.sdk.QueuedEvent
import android.content.Context
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

  /** One pull from a running request. */
  sealed class Pulled {
    class Event(val type: String, val dataJson: String) : Pulled()

    /** The terminal has been delivered; nothing follows it. */
    object End : Pulled()

    object Timeout : Pulled()
  }

  /**
   * One prepared explicit-local request with queued delivery: [run] is the
   * producer (returns once the terminal is queued), [next] the single
   * consumer, [cancel] cancels the operation (its terminal still arrives
   * through [next]), and [close] releases the handle.
   */
  interface Execution : AutoCloseable {
    fun run()

    fun next(timeoutMs: Int): Pulled

    fun cancel()
  }

  fun register(source: PcmAudioSource): Registration

  fun prepare(token: String, frames: Long, requestId: String, deadlineMs: Int): Execution

  /** Model leases still held (inference still running). */
  fun activeLeases(): Int
}

/**
 * The packaged public SDK surface only (AJ ADR-021/022): one
 * [NativeHybridAIClient] created with the exact pinned model configuration,
 * `registerAudioSource(source, "audio.transcribe", 1)`, and the public queued
 * pull execution (`prepare`, `runQueued`, `nextEvent`, `cancel`;
 * RI-SHARED-DEC-001 S6, the surface `stream()` is built on) with an explicit
 * `LOCAL` target. Holding the operation lets a cancel observe the request's
 * own terminal. Closing this engine closes the client; it is not
 * cancellation, so [RecordingTranscriptions] cancels first.
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

  override fun prepare(token: String, frames: Long, requestId: String, deadlineMs: Int): TranscriptionEngine.Execution {
    val operation: NativeExecutionOperation =
        client.prepare(
            ExecuteRequest(
                TranscriptionPins.CAPABILITY,
                input(token, frames),
                ExecutionTarget.LOCAL,
                majorVersion = TranscriptionPins.CAPABILITY_MAJOR.toUInt(),
                requestId = requestId,
                deadlineMs = deadlineMs))
    return object : TranscriptionEngine.Execution {
      override fun run() = operation.runQueued()

      override fun next(timeoutMs: Int): TranscriptionEngine.Pulled =
          when (val pulled = operation.nextEvent(timeoutMs)) {
            is QueuedEvent.Event -> TranscriptionEngine.Pulled.Event(pulled.event.type, pulled.event.dataJson)
            QueuedEvent.End -> TranscriptionEngine.Pulled.End
            QueuedEvent.Timeout -> TranscriptionEngine.Pulled.Timeout
          }

      override fun cancel() = operation.cancel()

      override fun close() = operation.close()
    }
  }

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
