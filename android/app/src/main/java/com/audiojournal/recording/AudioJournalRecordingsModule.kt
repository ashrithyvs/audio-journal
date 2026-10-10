package com.audiojournal.recording

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioAttributes
import androidx.core.content.ContextCompat
import com.audiojournal.specs.NativeAudioJournalRecordingsSpec
import com.audiojournal.vault.VaultHolder
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import java.io.RandomAccessFile
import javax.crypto.AEADBadTagException
import org.json.JSONArray
import org.json.JSONObject

/**
 * TurboModule over native AJR1 capture and playback (ADR-017, LLD §5).
 * Recording keys come from the unlocked vault (`aj-rec-v1`) and never leave
 * native code; events carry progress and positions only. Leaving the
 * foreground or losing audio focus pauses both capture and playback.
 * Errors carry a code, never a path or content. Nothing is logged.
 */
class AudioJournalRecordingsModule(private val context: ReactApplicationContext) :
    NativeAudioJournalRecordingsSpec(context), LifecycleEventListener {

  private val files by lazy { RecordingFiles(context.noBackupFilesDir) }

  init {
    context.addLifecycleEventListener(this)
  }

  override fun getName() = NAME

  private fun rootKey(): ByteArray = VaultHolder.get(context).purposeKey(RECORDING_KEY_LABEL)

  private fun settle(promise: Promise, work: () -> Any?) {
    ActiveAudio.execute {
      try {
        promise.resolve(work())
      } catch (failure: Throwable) {
        val code =
            when {
              failure is IllegalStateException && failure.message == "STORE_LOCKED" -> "STORE_LOCKED"
              failure is IllegalStateException && failure.message?.matches(CODE) == true ->
                  failure.message!!
              else -> "RECORDER_FAILED"
            }
        promise.reject(code, code)
      }
    }
  }

  // --- Capture ---

  private fun emitRecording(
      recordingId: String,
      type: String,
      reason: String = "",
      progress: CaptureProgress? = null,
  ) {
    emitOnRecordingEvent(
        Arguments.createMap().apply {
          putString("recordingId", recordingId)
          putString("type", type)
          putString("reason", reason)
          putDouble("capturedMs", (progress?.capturedMs ?: 0L).toDouble())
          putDouble("sealedChunks", (progress?.sealedChunks ?: 0).toDouble())
          putDouble("byteCount", (progress?.byteCount ?: 0L).toDouble())
          putDouble("freeBytes", (progress?.freeBytes ?: 0L).toDouble())
          putDouble("level", progress?.level ?: 0.0)
        })
  }

  override fun freeBytes(promise: Promise) = settle(promise) { files.freeBytes().toDouble() }

  private fun refusal(name: String) = JSONObject().put("ok", false).put("refusal", name).toString()

  override fun prepare(recordingId: String, promise: Promise) = settle(promise) {
    val busy = ActiveAudio.capture?.state
    if (busy != null &&
        busy != CaptureSession.State.FINISHED &&
        busy != CaptureSession.State.FAILED &&
        busy != CaptureSession.State.CLOSED) {
      return@settle refusal("RECORDER_UNAVAILABLE")
    }
    ActiveAudio.releaseCapture()
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) !=
        PackageManager.PERMISSION_GRANTED) {
      return@settle refusal("MICROPHONE_DENIED")
    }
    if (files.freeBytes() < CaptureLimits.ADR_017.minFreeBytesToStart) {
      return@settle refusal("STORAGE_EXHAUSTED")
    }
    val file = files.fileFor(recordingId)
    // Never overwrite: an existing file is someone's audio.
    if (file.exists()) return@settle refusal("RECORDER_UNAVAILABLE")
    val source =
        try {
          AudioRecordSource(ContextCompat.getMainExecutor(context)) {
            ActiveAudio.execute { ActiveAudio.capture?.pause("audio_focus_lost") }
          }
        } catch (_: Exception) {
          return@settle refusal("RECORDER_UNAVAILABLE")
        }
    val key =
        try {
          rootKey()
        } catch (_: Exception) {
          source.release()
          return@settle refusal("RECORDER_UNAVAILABLE")
        }
    val writer =
        try {
          Ajr1Writer.create(file, recordingId, key)
        } catch (_: Exception) {
          source.release()
          file.delete() // at most a header: nothing captured yet
          return@settle refusal("RECORDER_UNAVAILABLE")
        } finally {
          key.fill(0)
        }
    ActiveAudio.capture =
        CaptureSession(
            recordingId,
            file,
            writer,
            source,
            files::freeBytes,
            ::rootKey,
            object : CaptureListener {
              override fun onProgress(progress: CaptureProgress) =
                  emitRecording(recordingId, "progress", progress = progress)

              override fun onPaused(reason: String) = emitRecording(recordingId, "paused", reason)

              override fun onEnded(cause: String, progress: CaptureProgress) =
                  emitRecording(recordingId, "ended_abnormally", cause, progress)
            })
    JSONObject().put("ok", true).toString()
  }

  private fun captureFocus() =
      AudioFocus(context, AudioAttributes.USAGE_MEDIA) {
        ActiveAudio.execute { ActiveAudio.capture?.pause("audio_focus_lost") }
      }

  override fun start(recordingId: String, promise: Promise) = settle(promise) {
    val session = ActiveAudio.capture
    if (session == null || session.recordingId != recordingId) {
      throw IllegalStateException("RECORDER_STATE")
    }
    ActiveAudio.stopPlayback()
    val focus = captureFocus().also { ActiveAudio.captureFocus = it }
    // Emitted before the capture thread exists, so a failure cannot overtake it.
    emitRecording(recordingId, "started")
    // Another app holds focus (for example, a call): start paused until the
    // user resumes, rather than sealing silence.
    if (focus.request()) session.start() else session.startPaused("audio_focus_lost")
    null
  }

  override fun pause(promise: Promise) = settle(promise) {
    ActiveAudio.capture?.pause("user")
    null
  }

  override fun resume(promise: Promise) = settle(promise) {
    val session = ActiveAudio.capture ?: throw IllegalStateException("RECORDER_STATE")
    if (session.state == CaptureSession.State.PAUSED) {
      val focus = ActiveAudio.captureFocus ?: captureFocus().also { ActiveAudio.captureFocus = it }
      session.resume()
      if (!focus.request()) session.pause("audio_focus_lost")
    }
    null
  }

  override fun finish(promise: Promise) = settle(promise) {
    val session = ActiveAudio.capture ?: throw IllegalStateException("RECORDER_STATE")
    try {
      val result = session.finish()
      JSONObject()
          .put("durationMs", result.durationMs)
          .put("sealedChunks", result.sealedChunks)
          .put("byteCount", result.byteCount)
          .put("contentSha256", result.contentSha256)
          .toString()
    } finally {
      ActiveAudio.releaseCapture()
    }
  }

  override fun discard(recordingId: String, promise: Promise) = settle(promise) {
    val session = ActiveAudio.capture
    if (session != null && session.recordingId == recordingId) {
      session.discard()
      ActiveAudio.capture = null
      ActiveAudio.captureFocus?.abandon()
      ActiveAudio.captureFocus = null
    }
    null
  }

  /** The open capture's file must not be scanned, truncated, or moved. */
  private fun openCaptureId(): String? =
      ActiveAudio.capture?.takeIf {
        it.state != CaptureSession.State.FINISHED &&
            it.state != CaptureSession.State.FAILED &&
            it.state != CaptureSession.State.CLOSED
      }?.recordingId

  override fun scan(authenticateJson: String, promise: Promise) = settle(promise) {
    val ids = JSONArray(authenticateJson)
    val authenticate = (0 until ids.length()).map { ids.getString(it) }.toSet()
    val open = openCaptureId()
    val all = files.scan(authenticate - setOfNotNull(open), ::rootKey)
    val out = JSONArray()
    for (at in 0 until all.length()) {
      val entry = all.getJSONObject(at)
      if (open == null || entry.getString("relativePath") != "recordings/$open.ajr") out.put(entry)
    }
    out.toString()
  }

  override fun dropTornTail(recordingId: String, sealedChunks: Double, promise: Promise) =
      settle(promise) {
        if (recordingId == openCaptureId()) throw IllegalStateException("RECORDER_STATE")
        val key = rootKey()
        try {
          files.dropTornTail(recordingId, sealedChunks.toInt(), key)
        } finally {
          key.fill(0)
        }
        null
      }

  override fun quarantine(relativePath: String, promise: Promise) = settle(promise) {
    val open = openCaptureId()
    if (open != null && relativePath == "recordings/$open.ajr") {
      throw IllegalStateException("RECORDER_STATE")
    }
    files.quarantine(relativePath, System.currentTimeMillis())
    null
  }

  // --- Playback ---

  private fun emitPlayback(playbackId: String, type: String, positionMs: Long = 0, code: String = "") {
    emitOnPlaybackEvent(
        Arguments.createMap().apply {
          putString("playbackId", playbackId)
          putString("type", type)
          putDouble("positionMs", positionMs.toDouble())
          putString("code", code)
        })
  }

  override fun play(
      playbackId: String,
      recordingId: String,
      startMs: Double,
      endMs: Double,
      promise: Promise,
  ) = settle(promise) {
    ActiveAudio.stopPlayback()
    if (recordingId == openCaptureId()) {
      emitPlayback(playbackId, "failed", code = "PLAYBACK_UNAVAILABLE")
      return@settle null
    }
    val file = files.fileFor(recordingId)
    val raf =
        try {
          RandomAccessFile(file, "r")
        } catch (_: Exception) {
          emitPlayback(playbackId, "failed", code = "SOURCE_DAMAGED")
          return@settle null
        }
    val key = rootKey()
    val reader =
        try {
          Ajr1Reader(Ajr1.FileSource(raf), key, recordingId)
        } catch (_: IllegalArgumentException) {
          raf.close()
          emitPlayback(playbackId, "failed", code = "SOURCE_DAMAGED")
          return@settle null
        } catch (failure: Exception) {
          raf.close()
          throw failure
        } finally {
          key.fill(0)
        }
    val focus =
        AudioFocus(context, AudioAttributes.USAGE_MEDIA) {
          ActiveAudio.execute { ActiveAudio.playback?.pause("audio_focus_lost") }
        }
    if (!focus.request()) {
      reader.close()
      emitPlayback(playbackId, "failed", code = "PLAYBACK_UNAVAILABLE")
      return@settle null
    }
    val sink =
        try {
          AudioTrackSink()
        } catch (_: Exception) {
          reader.close()
          focus.abandon()
          emitPlayback(playbackId, "failed", code = "PLAYBACK_UNAVAILABLE")
          return@settle null
        }
    lateinit var session: PlaybackSession
    // A playback that ended by itself releases focus; a newer one is untouched.
    val release = {
      ActiveAudio.execute { if (ActiveAudio.playback === session) ActiveAudio.stopPlayback() }
    }
    session =
        PlaybackSession(
            reader,
            sink,
            startMs.toLong().coerceAtLeast(0),
            endMs.takeIf { it >= 0 }?.toLong(),
            object : PlaybackListener {
              override fun onPosition(positionMs: Long) =
                  emitPlayback(playbackId, "position", positionMs)

              override fun onPaused(positionMs: Long) =
                  emitPlayback(playbackId, "paused", positionMs)

              override fun onEnded() {
                emitPlayback(playbackId, "ended")
                release()
              }

              override fun onFailed(code: String) {
                emitPlayback(playbackId, "failed", code = code)
                release()
              }
            })
    ActiveAudio.playback = session
    ActiveAudio.playbackFocus = focus
    session.start()
    null
  }

  override fun pausePlayback(promise: Promise) = settle(promise) {
    ActiveAudio.playback?.pause("user")
    ActiveAudio.playback = null
    ActiveAudio.playbackFocus?.abandon()
    ActiveAudio.playbackFocus = null
    null
  }

  override fun stopPlayback(promise: Promise) = settle(promise) {
    ActiveAudio.stopPlayback()
    null
  }

  // --- Lifecycle: leaving the foreground pauses (ADR-017; no foreground service) ---

  override fun onHostPause() {
    ActiveAudio.execute {
      ActiveAudio.capture?.pause("backgrounded")
      ActiveAudio.playback?.pause("backgrounded")
      ActiveAudio.playback = null
      ActiveAudio.playbackFocus?.abandon()
      ActiveAudio.playbackFocus = null
    }
  }

  override fun onHostResume() = Unit

  override fun onHostDestroy() {
    ActiveAudio.execute {
      ActiveAudio.stopPlayback()
      ActiveAudio.releaseCapture()
    }
  }

  override fun invalidate() {
    context.removeLifecycleEventListener(this)
    super.invalidate()
  }

  companion object {
    const val NAME = "AudioJournalRecordings"
    const val RECORDING_KEY_LABEL = "aj-rec-v1"
    private val CODE = Regex("^[A-Z][A-Z0-9_]{2,40}$")
  }
}
