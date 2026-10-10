package com.audiojournal.speech

import com.audiojournal.recording.Ajr1Reader

/**
 * Recording transcriptions in progress. Locking the vault cancels them and
 * closes their readers, which zeroes the recording keys (ADR-017). A job
 * leaves the registry before its whisper cancel handle is freed, so a lock
 * never touches a freed handle.
 */
object RecordingJobs {
  class Job(val requestId: String, val cancel: Long, val reader: Ajr1Reader) {
    @Volatile var cancelled = false
  }

  private val jobs = HashMap<String, Job>()

  @Synchronized
  fun register(requestId: String, cancel: Long, reader: Ajr1Reader): Job =
      Job(requestId, cancel, reader).also { jobs[requestId] = it }

  @Synchronized
  fun finish(job: Job) {
    if (jobs[job.requestId] === job) jobs.remove(job.requestId)
    job.reader.close()
  }

  @Synchronized
  fun cancelAll() {
    for (job in jobs.values) {
      job.cancelled = true
      WhisperNative.cancel(job.cancel)
      job.reader.close()
    }
  }
}
