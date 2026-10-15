package com.audiojournal.speech

import android.os.Debug
import com.audiojournal.specs.NativeAudioJournalSpeechSpec
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import java.io.File
import java.util.concurrent.Executors
import org.json.JSONObject

/**
 * Final transcription of sealed recordings through the packaged Hybrid AI SDK
 * (AJ ADR-021/022): [RecordingJobs] feeds the decrypted AJR1 PCM to the SDK's
 * `audio.transcribe@1` natively. No audio, key, or path crosses the bridge;
 * only result codes, times, and validated segment text return, and nothing is
 * logged. Audio Journal links no model runtime of its own.
 */
class AudioJournalSpeechModule(private val context: ReactApplicationContext) :
    NativeAudioJournalSpeechSpec(context) {

  // One final pass at a time (the JS controller queues); cancels are direct calls.
  private val worker = Executors.newSingleThreadExecutor { Thread(it, "aj-transcription") }
  private val diagnosticsWorker = Executors.newSingleThreadExecutor { Thread(it, "aj-transcription-diag") }

  override fun getName() = NAME

  override fun transcribeRecording(requestId: String, recordingId: String, promise: Promise) {
    worker.execute {
      try {
        val result = RecordingJobs.get(context).transcribe(requestId, recordingId)
        promise.resolve(result.toJson().toString())
      } catch (error: Throwable) {
        // Error class only: messages could carry paths.
        promise.reject("TRANSCRIPTION_FAILED", error.javaClass.simpleName)
      }
    }
  }

  /** The request ends with `cancelled` once the SDK operation has ended. */
  override fun cancel(requestId: String) {
    RecordingJobs.get(context).cancel(requestId)
  }

  override fun activeTranscriptions(): Double = RecordingJobs.get(context).activeCount().toDouble()

  /** Content-free: active jobs, model leases, step traces, and process memory. */
  override fun diagnostics(promise: Promise) {
    diagnosticsWorker.execute {
      try {
        promise.resolve(RecordingJobs.get(context).diagnostics().put("memory", memory()).toString())
      } catch (error: Throwable) {
        promise.reject("DIAGNOSTICS_FAILED", error.javaClass.simpleName)
      }
    }
  }

  private fun memory(): JSONObject {
    val status = File("/proc/self/status").readText()
    fun kb(key: String) = Regex("$key:\\s+(\\d+)").find(status)?.groupValues?.get(1)?.toLong() ?: -1
    return JSONObject()
        .put("vmRssKb", kb("VmRSS"))
        .put("vmHwmKb", kb("VmHWM"))
        .put("nativeHeapKb", Debug.getNativeHeapAllocatedSize() / 1024)
  }

  override fun invalidate() {
    // Cancel before close: closing the client alone is not cancellation.
    runCatching { RecordingJobs.close() }
    worker.shutdown()
    diagnosticsWorker.shutdown()
    super.invalidate()
  }

  companion object {
    const val NAME = "AudioJournalSpeech"
  }
}
