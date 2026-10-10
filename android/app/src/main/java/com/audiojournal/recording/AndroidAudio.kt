package com.audiojournal.recording

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioRecordingConfiguration
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.Build
import java.util.concurrent.Executor

/**
 * The microphone at 16 kHz mono s16le. On Android 10+, being silenced by a
 * higher-priority capture (for example, a call) is reported like a focus
 * loss, so the recording pauses instead of sealing silence.
 */
class AudioRecordSource(executor: Executor, onSilenced: () -> Unit) : PcmSource {
  private val record: AudioRecord
  private var callback: Any? = null

  init {
    val minimum =
        AudioRecord.getMinBufferSize(
            Ajr1.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    if (minimum <= 0) throw IllegalStateException("RECORDER_UNAVAILABLE")
    @SuppressLint("MissingPermission") // prepare() checks RECORD_AUDIO first
    val created =
        AudioRecord(
            MediaRecorder.AudioSource.MIC,
            Ajr1.SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            maxOf(minimum * 2, Ajr1.MAX_CHUNK_BYTES))
    if (created.state != AudioRecord.STATE_INITIALIZED) {
      created.release()
      throw IllegalStateException("RECORDER_UNAVAILABLE")
    }
    record = created
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val silenced =
          object : AudioManager.AudioRecordingCallback() {
            override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
              val mine = configs.firstOrNull { it.clientAudioSessionId == record.audioSessionId }
              if (mine?.isClientSilenced == true) onSilenced()
            }
          }
      record.registerAudioRecordingCallback(executor, silenced)
      callback = silenced
    }
  }

  override fun start() {
    record.startRecording()
    if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
      throw IllegalStateException("RECORDER_UNAVAILABLE")
    }
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int) = record.read(buffer, offset, length)

  override fun stop() {
    if (record.recordingState == AudioRecord.RECORDSTATE_RECORDING) record.stop()
  }

  override fun release() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      (callback as? AudioManager.AudioRecordingCallback)?.let {
        record.unregisterAudioRecordingCallback(it)
      }
    }
    callback = null
    record.release()
  }
}

/** Audio focus for capture or playback; any loss is reported once per request. */
class AudioFocus(context: Context, usage: Int, private val onLoss: () -> Unit) {
  private val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val request =
      AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
          .setAudioAttributes(
              AudioAttributes.Builder()
                  .setUsage(usage)
                  .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                  .build())
          .setOnAudioFocusChangeListener { change ->
            if (change == AudioManager.AUDIOFOCUS_LOSS ||
                change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT ||
                change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) {
              onLoss()
            }
          }
          .build()

  /** False when another app holds focus (for example, during a call). */
  fun request(): Boolean =
      manager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED

  fun abandon() {
    manager.abandonAudioFocusRequest(request)
  }
}

/** Streams 16 kHz mono s16le to the speaker. */
class AudioTrackSink : PcmSink {
  private val track =
      AudioTrack.Builder()
          .setAudioAttributes(
              AudioAttributes.Builder()
                  .setUsage(AudioAttributes.USAGE_MEDIA)
                  .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                  .build())
          .setAudioFormat(
              AudioFormat.Builder()
                  .setSampleRate(Ajr1.SAMPLE_RATE)
                  .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                  .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                  .build())
          .setBufferSizeInBytes(
              maxOf(
                  AudioTrack.getMinBufferSize(
                      Ajr1.SAMPLE_RATE,
                      AudioFormat.CHANNEL_OUT_MONO,
                      AudioFormat.ENCODING_PCM_16BIT),
                  Ajr1.MAX_CHUNK_BYTES / 4))
          .setTransferMode(AudioTrack.MODE_STREAM)
          .build()

  @Volatile private var released = false

  override fun play() = track.play()

  override fun write(pcm: ByteArray, offset: Int, length: Int): Int =
      track.write(pcm, offset, length)

  override val playedSamples: Long
    get() = if (released) 0L else track.playbackHeadPosition.toLong() and 0xffffffffL

  /** Called from the control and playback threads; safe to repeat. */
  @Synchronized
  override fun stop() {
    if (!released && track.playState != AudioTrack.PLAYSTATE_STOPPED) {
      track.pause()
      track.flush()
      track.stop()
    }
  }

  @Synchronized
  override fun release() {
    if (!released) {
      released = true
      track.release()
    }
  }
}
