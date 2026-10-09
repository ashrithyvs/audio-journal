package com.audiojournal.speech

import android.os.Debug
import android.os.SystemClock
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

/**
 * App-owned on-device transcription (ADR-016). Audio and transcript text stay
 * in this process; nothing is logged. Development fixtures are read and
 * results written only inside the app's own `speech-eval` directory.
 */
class AudioJournalSpeechModule(private val context: ReactApplicationContext) :
    NativeAudioJournalSpeechSpec(context) {

  private val executor = Executors.newFixedThreadPool(4)
  private val cancels = ConcurrentHashMap<String, Long>()
  private val models = ConcurrentHashMap<String, Long>()
  private val loadMs = ConcurrentHashMap<String, Double>()
  // Reused decoder states per model (at most one per executor thread).
  private val states = ConcurrentHashMap<String, ConcurrentLinkedQueue<Long>>()

  private fun borrowState(id: String, model: Long): Long =
      states.getOrPut(id) { ConcurrentLinkedQueue() }.poll()
          ?: WhisperNative.newState(model).also { if (it == 0L) throw IllegalStateException("state") }

  private fun returnState(id: String, state: Long) {
    states.getOrPut(id) { ConcurrentLinkedQueue() }.add(state)
  }

  override fun getName() = NAME

  private fun evalRoot(): File? = context.getExternalFilesDir("speech-eval")

  /** Resolves a path and refuses anything outside the app's own storage. */
  private fun allowed(path: String): File {
    val file = File(path).canonicalFile
    val roots = listOfNotNull(context.filesDir, context.noBackupFilesDir, evalRoot()).map { it.canonicalPath }
    if (roots.none { file.path.startsWith("$it/") }) throw SecurityException("path outside app storage")
    return file
  }

  @Synchronized
  private fun model(id: String): Long {
    models[id]?.let { return it }
    val started = SystemClock.elapsedRealtimeNanos()
    val handle = WhisperNative.loadModel(SpeechModels.file(context, id).absolutePath)
    if (handle == 0L) throw IllegalStateException("model load failed")
    loadMs[id] = (SystemClock.elapsedRealtimeNanos() - started) / 1e6
    models[id] = handle
    return handle
  }

  override fun models(promise: Promise) {
    executor.execute {
      val list = JSONArray()
      for ((id, sha) in SpeechModels.pinned) {
        list.put(
            JSONObject()
                .put("id", id)
                .put("sha256", sha)
                .put("bundled", SpeechModels.bundled(context, id))
                .put("isDefault", id == SpeechModels.DEFAULT)
                .put("loaded", models.containsKey(id)))
      }
      promise.resolve(JSONObject().put("models", list).put("system", WhisperNative.systemInfo()).toString())
    }
  }

  override fun transcribe(
      requestId: String,
      audioPath: String,
      model: String,
      threads: Double,
      promise: Promise
  ) {
    val cancel = WhisperNative.newCancel()
    cancels[requestId] = cancel
    executor.execute {
      val queuedMs = 0.0
      val started = SystemClock.elapsedRealtimeNanos()
      fun elapsed() = (SystemClock.elapsedRealtimeNanos() - started) / 1e6
      try {
        val readStart = elapsed()
        val pcm = Wav.read16kMono(allowed(audioPath))
        val readMs = elapsed() - readStart
        val wasLoaded = models.containsKey(model)
        val handle = model(model)
        val state = borrowState(model, handle)
        var firstSegmentMs = -1.0
        var segmentCount = 0
        val inferenceStart = elapsed()
        val raw =
            try {
            WhisperNative.transcribe(
                handle,
                state,
                pcm,
                threads.toInt().coerceIn(1, 8),
                cancel,
                object : SegmentListener {
                  override fun onSegment(t0Ms: Long, t1Ms: Long, text: String) {
                    if (firstSegmentMs < 0) firstSegmentMs = elapsed() - inferenceStart
                    segmentCount += 1
                    emitOnSegment(
                        Arguments.createMap().apply {
                          putString("requestId", requestId)
                          putDouble("t0Ms", t0Ms.toDouble())
                          putDouble("t1Ms", t1Ms.toDouble())
                          putString("text", text)
                        })
                  }
                })
            } finally {
              returnState(model, state)
            }
        val result = JSONObject(raw)
        val timings = result.getJSONObject("timings")
        timings
            .put("queuedMs", queuedMs)
            .put("readMs", readMs)
            .put("modelLoadMs", if (wasLoaded) 0.0 else loadMs[model] ?: 0.0)
            .put("firstSegmentMs", firstSegmentMs)
            .put("totalMs", elapsed())
            .put("audioMs", pcm.size / 16.0)
        result.put("model", model).put("memory", memory())
        promise.resolve(result.toString())
      } catch (error: Throwable) {
        // Error class only: messages could carry paths.
        promise.reject("TRANSCRIPTION_FAILED", error.javaClass.simpleName)
      } finally {
        cancels.remove(requestId)
        WhisperNative.freeCancel(cancel)
      }
    }
  }

  override fun cancel(requestId: String) {
    cancels[requestId]?.let { WhisperNative.cancel(it) }
  }

  override fun evalDirectory(): String = evalRoot()?.absolutePath ?: ""

  override fun readEvalFile(relativePath: String, promise: Promise) {
    executor.execute {
      try {
        val root = evalRoot() ?: throw IllegalStateException("no eval directory")
        promise.resolve(allowed(File(root, relativePath).path).readText())
      } catch (error: Throwable) {
        promise.reject("EVAL_IO", error.javaClass.simpleName)
      }
    }
  }

  override fun appendEvalFile(relativePath: String, line: String, promise: Promise) {
    try {
      val root = evalRoot() ?: throw IllegalStateException("no eval directory")
      val file = allowed(File(root, relativePath).path)
      file.parentFile?.mkdirs()
      synchronized(this) { file.appendText(line + "\n") }
      promise.resolve(null)
    } catch (error: Throwable) {
      promise.reject("EVAL_IO", error.javaClass.simpleName)
    }
  }

  override fun memorySnapshot(): String = memory().toString()

  private fun memory(): JSONObject {
    val status = File("/proc/self/status").readText()
    fun kb(key: String) = Regex("$key:\\s+(\\d+)").find(status)?.groupValues?.get(1)?.toLong() ?: -1
    return JSONObject()
        .put("vmRssKb", kb("VmRSS"))
        .put("vmHwmKb", kb("VmHWM"))
        .put("nativeHeapKb", Debug.getNativeHeapAllocatedSize() / 1024)
  }

  override fun invalidate() {
    for (cancel in cancels.values) WhisperNative.cancel(cancel)
    executor.shutdown()
    for (queue in states.values) queue.forEach(WhisperNative::freeState)
    for (handle in models.values) WhisperNative.freeModel(handle)
    super.invalidate()
  }

  companion object {
    const val NAME = "AudioJournalSpeech"
  }
}
