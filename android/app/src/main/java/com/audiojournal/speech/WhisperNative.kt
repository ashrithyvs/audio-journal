package com.audiojournal.speech

/** Receives each decoded segment; called from the native decoder thread. */
interface SegmentListener {
  fun onSegment(t0Ms: Long, t1Ms: Long, text: String)
}

/** JNI surface of libaj_whisper (android/speech-engine, ADR-016). */
object WhisperNative {
  init {
    System.loadLibrary("aj_whisper")
  }

  @JvmStatic external fun loadModel(path: String): Long

  @JvmStatic external fun freeModel(handle: Long)

  @JvmStatic external fun newState(model: Long): Long

  @JvmStatic external fun freeState(state: Long)

  @JvmStatic external fun newCancel(): Long

  @JvmStatic external fun cancel(handle: Long)

  @JvmStatic external fun freeCancel(handle: Long)

  @JvmStatic external fun systemInfo(): String

  @JvmStatic
  external fun transcribe(
      model: Long,
      state: Long,
      pcm: FloatArray,
      threads: Int,
      cancel: Long,
      listener: SegmentListener,
  ): String
}
