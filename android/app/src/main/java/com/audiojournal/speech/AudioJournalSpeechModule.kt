package com.audiojournal.speech

import android.os.Debug
import android.os.SystemClock
import com.audiojournal.recording.Ajr1
import com.audiojournal.recording.Ajr1Reader
import com.audiojournal.recording.ActiveAudio
import com.audiojournal.recording.CaptureSession
import com.audiojournal.recording.RecordingFiles
import com.audiojournal.specs.NativeAudioJournalSpeechSpec
import com.audiojournal.vault.VaultHolder
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.AEADBadTagException
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
  // Requests whose promise was settled early by cancel(); native work may
  // still be finishing until whisper's next abort point.
  private val pending = ConcurrentHashMap<String, Pair<Promise, Long>>()
  private val active = AtomicInteger(0)
  private val models = ConcurrentHashMap<String, Long>()
  private val loadMs = ConcurrentHashMap<String, Double>()
  // Reused decoder states per model (at most one per executor thread).
  private val states = ConcurrentHashMap<String, ConcurrentLinkedQueue<Long>>()
  private val lives = ConcurrentHashMap<String, LiveTranscriber>()

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
    pending[requestId] = promise to SystemClock.elapsedRealtimeNanos()
    // Settles the promise exactly once, whether by completion or early cancel.
    fun settle(block: (Promise) -> Unit) {
      pending.remove(requestId)?.let { (settled, _) -> block(settled) }
    }
    executor.execute {
      active.incrementAndGet()
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
        settle { it.resolve(result.toString()) }
      } catch (error: Throwable) {
        // Error class only: messages could carry paths.
        settle { it.reject("TRANSCRIPTION_FAILED", error.javaClass.simpleName) }
      } finally {
        cancels.remove(requestId)
        WhisperNative.freeCancel(cancel)
        active.decrementAndGet()
      }
    }
  }

  /**
   * Live provisional text for the capture in progress (ADR-017). Attaches a
   * [LiveTranscriber] to the open capture of [recordingId]; it closes with
   * the capture (finish, discard, lock) or on [stopLive]. Window results
   * arrive through `onLiveWindow`; their text is never logged. Resolves
   * false when that capture is not open.
   */
  override fun startLive(
      requestId: String,
      recordingId: String,
      model: String,
      threads: Double,
      promise: Promise
  ) {
    executor.execute {
      try {
        val handle = model(model)
        val state = borrowState(model, handle)
        val cancel = WhisperNative.newCancel()
        val silent =
            object : SegmentListener {
              override fun onSegment(t0Ms: Long, t1Ms: Long, text: String) = Unit
            }
        val live =
            LiveTranscriber(
                LiveTranscriber.PROVISIONAL_WINDOW_MS,
                LiveTranscriber.PROVISIONAL_CADENCE_MS,
                transcribe = { pcm ->
                  val raw =
                      JSONObject(
                          WhisperNative.transcribe(
                              handle, state, pcm, threads.toInt().coerceIn(1, 8), cancel, silent))
                  if (raw.getString("status") != "ok") null
                  else {
                    val list = raw.getJSONArray("segments")
                    (0 until list.length()).map {
                      val segment = list.getJSONObject(it)
                      RecordingPass.Segment(
                          segment.getLong("t0Ms"), segment.getLong("t1Ms"), segment.getString("text"))
                    }
                  }
                },
                cancel = { WhisperNative.cancel(cancel) },
                release = {
                  lives.remove(requestId)
                  returnState(model, state)
                  WhisperNative.freeCancel(cancel)
                },
                onWindow = { startMs, endMs, segments ->
                  val list = JSONArray()
                  segments.forEach {
                    list.put(JSONObject().put("t0Ms", it.t0Ms).put("t1Ms", it.t1Ms).put("text", it.text))
                  }
                  emitOnLiveWindow(
                      Arguments.createMap().apply {
                        putString("requestId", requestId)
                        putDouble("startMs", startMs.toDouble())
                        putDouble("endMs", endMs.toDouble())
                        putString("segmentsJson", list.toString())
                      })
                })
        lives[requestId] = live
        val attached =
            ActiveAudio.submit {
              val capture = ActiveAudio.capture
              val open =
                  capture != null &&
                      capture.recordingId == recordingId &&
                      (capture.state == CaptureSession.State.PREPARED ||
                          capture.state == CaptureSession.State.RECORDING ||
                          capture.state == CaptureSession.State.PAUSED)
              if (open) {
                capture!!.tap?.close()
                capture.tap = live
              }
              open
            }
        if (!attached) live.close()
        promise.resolve(attached)
      } catch (error: Throwable) {
        promise.reject("TRANSCRIPTION_FAILED", error.javaClass.simpleName)
      }
    }
  }

  override fun stopLive(requestId: String) {
    lives[requestId]?.close()
  }

  /**
   * Final pass over a sealed AJR1 recording (ADR-017): decrypted natively, in
   * bounded windows ([RecordingPass]), straight into whisper.cpp. Audio and
   * the recording key never leave native code. Segments arrive through
   * `onSegment` in absolute time. Locking the vault cancels the pass.
   */
  override fun transcribeRecording(
      requestId: String,
      recordingId: String,
      model: String,
      threads: Double,
      promise: Promise
  ) {
    val cancel = WhisperNative.newCancel()
    pending[requestId] = promise to SystemClock.elapsedRealtimeNanos()
    fun settle(block: (Promise) -> Unit) {
      pending.remove(requestId)?.let { (settled, _) -> block(settled) }
    }
    executor.execute {
      active.incrementAndGet()
      val started = SystemClock.elapsedRealtimeNanos()
      fun elapsed() = (SystemClock.elapsedRealtimeNanos() - started) / 1e6
      var job: RecordingJobs.Job? = null
      try {
        val file = RecordingFiles(context.noBackupFilesDir).fileFor(recordingId)
        val key = VaultHolder.get(context).purposeKey(RECORDING_KEY_LABEL)
        val reader =
            try {
              Ajr1Reader(Ajr1.FileSource(RandomAccessFile(file, "r")), key, recordingId)
            } finally {
              key.fill(0)
            }
        job = RecordingJobs.register(requestId, cancel, reader)
        cancels[requestId] = cancel
        val handle = model(model)
        val state = borrowState(model, handle)
        var inferenceMs = 0.0
        var firstSegmentMs = -1.0
        var status = "ok"
        val segments =
            try {
              RecordingPass(reader).run { startMs, pcm ->
                val windowStart = elapsed()
                val raw =
                    JSONObject(
                        WhisperNative.transcribe(
                            handle,
                            state,
                            pcm,
                            threads.toInt().coerceIn(1, 8),
                            cancel,
                            object : SegmentListener {
                              override fun onSegment(t0Ms: Long, t1Ms: Long, text: String) {
                                if (firstSegmentMs < 0) firstSegmentMs = elapsed()
                                emitOnSegment(
                                    Arguments.createMap().apply {
                                      putString("requestId", requestId)
                                      putDouble("t0Ms", (startMs + t0Ms).toDouble())
                                      putDouble("t1Ms", (startMs + t1Ms).toDouble())
                                      putString("text", text)
                                    })
                              }
                            }))
                inferenceMs += elapsed() - windowStart
                status = raw.getString("status")
                if (status != "ok") return@run null
                val list = raw.getJSONArray("segments")
                (0 until list.length()).map {
                  val segment = list.getJSONObject(it)
                  RecordingPass.Segment(
                      segment.getLong("t0Ms"), segment.getLong("t1Ms"), segment.getString("text"))
                }
              }
            } finally {
              returnState(model, state)
            }
        val json = JSONObject().put("status", if (segments == null) status else "ok")
        val list = JSONArray()
        segments?.forEach {
          list.put(JSONObject().put("t0Ms", it.t0Ms).put("t1Ms", it.t1Ms).put("text", it.text))
        }
        json
            .put("segments", list)
            .put("model", model)
            .put(
                "timings",
                JSONObject()
                    .put("inferenceMs", inferenceMs)
                    .put("firstSegmentMs", firstSegmentMs)
                    .put("totalMs", elapsed())
                    .put("audioMs", reader.pcmBytes / 32))
            .put("memory", memory())
        settle { it.resolve(json.toString()) }
      } catch (error: Throwable) {
        when {
          // A lock mid-pass closes the reader; whatever failed after that is a cancel.
          job?.cancelled == true ->
              settle {
                it.resolve(
                    JSONObject().put("status", "cancelled").put("segments", JSONArray()).toString())
              }
          error is AEADBadTagException -> settle { it.reject("SOURCE_DAMAGED", "SOURCE_DAMAGED") }
          // Error class only: messages could carry paths.
          else -> settle { it.reject("TRANSCRIPTION_FAILED", error.javaClass.simpleName) }
        }
      } finally {
        cancels.remove(requestId)
        job?.let { RecordingJobs.finish(it) }
        WhisperNative.freeCancel(cancel)
        active.decrementAndGet()
      }
    }
  }

  /**
   * whisper.cpp checks its abort callback only between encoder and decoder
   * passes, so compute can run for up to one encoder pass after a cancel. The
   * request is acknowledged as cancelled immediately; the native work is
   * released at the next abort point and its result is discarded.
   */
  override fun cancel(requestId: String) {
    cancels[requestId]?.let { WhisperNative.cancel(it) }
    pending.remove(requestId)?.let { (promise, _) ->
      promise.resolve(
          JSONObject()
              .put("status", "cancelled")
              .put("segments", JSONArray())
              .put("acknowledgedEarly", true)
              .toString())
    }
  }

  /** Native transcriptions still computing, including early-cancelled ones. */
  override fun activeTranscriptions(): Double = active.get().toDouble()

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
    for (live in lives.values) live.close()
    for (cancel in cancels.values) WhisperNative.cancel(cancel)
    executor.shutdown()
    for (queue in states.values) queue.forEach(WhisperNative::freeState)
    for (handle in models.values) WhisperNative.freeModel(handle)
    super.invalidate()
  }

  companion object {
    const val NAME = "AudioJournalSpeech"
    const val RECORDING_KEY_LABEL = "aj-rec-v1"
  }
}
