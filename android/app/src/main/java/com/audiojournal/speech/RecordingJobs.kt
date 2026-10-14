package com.audiojournal.speech

import android.content.Context
import com.audiojournal.recording.ActiveAudio
import com.audiojournal.recording.Ajr1
import com.audiojournal.recording.Ajr1Reader
import com.audiojournal.recording.AudioJournalRecordingsModule
import com.audiojournal.recording.RecordingFiles
import com.audiojournal.vault.VaultHolder
import java.io.RandomAccessFile

/**
 * The process's recording transcriptions (ADR-017, AJ ADR-022). The vault
 * calls [cancelAll] on lock, erase, and restore before it closes the journal
 * and zeroes keys: every SDK request is cancelled, its terminal awaited
 * (bounded), and only then is its source registration closed. The SDK client
 * is kept across locks (it holds no key or audio) and closed on teardown.
 */
object RecordingJobs {
  @Volatile private var instance: RecordingTranscriptions? = null

  fun get(context: Context): RecordingTranscriptions =
      instance
          ?: synchronized(this) {
            instance ?: production(context.applicationContext).also { instance = it }
          }

  /** Cancels before anything closes; a no-op before the first transcription. */
  fun cancelAll() {
    instance?.cancelAll()
  }

  /** Module teardown: cancel, then close the SDK client. */
  fun close() {
    synchronized(this) {
      instance?.close()
      instance = null
    }
  }

  private fun production(context: Context): RecordingTranscriptions {
    val pack = TranscriptionPack(context)
    return RecordingTranscriptions(
        engineFactory = { SdkTranscriptionEngine(context, pack) },
        openSource = { recordingId -> openSealed(context, recordingId) },
        isCapturing = { recordingId ->
          ActiveAudio.submit { ActiveAudio.capture?.recordingId == recordingId }
        },
    )
  }

  /**
   * A read-only source over the durable AJR1 file. The recording key leaves the
   * vault only into the reader, which zeroes it on close.
   */
  private fun openSealed(context: Context, recordingId: String): Ajr1PcmSource {
    val file =
        try {
          RecordingFiles(context.noBackupFilesDir).fileFor(recordingId)
        } catch (_: IllegalArgumentException) {
          throw RecordingTranscriptions.Refused("RECORDING_MISSING")
        }
    if (!file.isFile) throw RecordingTranscriptions.Refused("RECORDING_MISSING")
    val key =
        try {
          VaultHolder.get(context).purposeKey(AudioJournalRecordingsModule.RECORDING_KEY_LABEL)
        } catch (_: Exception) {
          throw RecordingTranscriptions.Refused("LOCKED")
        }
    try {
      val raf = RandomAccessFile(file, "r")
      val reader =
          try {
            Ajr1Reader(Ajr1.FileSource(raf), key, recordingId)
          } catch (_: Exception) {
            raf.close()
            throw RecordingTranscriptions.Refused("SOURCE_DAMAGED")
          }
      return Ajr1PcmSource(reader)
    } finally {
      key.fill(0)
    }
  }
}
