package com.audiojournal.speech

/**
 * The exact accepted `audio.transcribe@1` identity (AJ ADR-022, SDK RI-2 §16,
 * `RI-REV-2B`). The SDK owns the model, provider, and inference; Audio Journal
 * only pins what it deploys and checks what comes back. Nothing here may be
 * substituted: a different byte count or digest fails closed.
 */
object TranscriptionPins {
  const val CAPABILITY = "audio.transcribe"
  const val CAPABILITY_MAJOR = 1

  const val PROFILE_ID = "sdk.whisper.tiny-en-q5-1"
  const val PROFILE_VERSION = "1.0.0"
  const val PROFILE_SHA256 = "5d722be29fe7feae78c7880f12f7e6eae35458e9237753941a3c7d7e54a4e50b"

  const val PACKAGE_ID = "sdk.audio-transcribe.tiny-en"
  const val PACKAGE_REVISION = "1.0.0"
  const val PACKAGE_SHA256 = "f2f59c4d576acae207646a67b556123c3057c9798a5b97c388b9bef152696544"

  const val PROVIDER_ID = "whisper.cpp"
  const val PROVIDER_REVISION = "v1.9.5+d1be6fde.ri2-decode.1"
  const val DECODE_CONFIG_REVISION = "ri2-decode.1"

  const val MODEL_FILE = "ggml-tiny.en-q5_1.bin"
  const val MODEL_BYTES = 32_166_155L
  const val MODEL_SHA256 = "c77c5766f1cef09b6b7d47f21b546cbddd4157886b3b5d6d4f709e91e66c7c2b"

  /** 16 kHz mono s16le; the profile's `maxAudioMs` is 180,000. */
  const val SAMPLE_RATE = 16_000
  const val MAX_AUDIO_MS = 180_000L
  const val MAX_FRAMES = MAX_AUDIO_MS * SAMPLE_RATE / 1_000

  /**
   * Stored with each engine revision (transcript `modelId`). `<profileId>_<version>`
   * fits the frozen store and AJB1 grammar `^[a-z0-9][a-z0-9._-]{0,63}$`.
   */
  const val MODEL_ID = "${PROFILE_ID}_$PROFILE_VERSION"
}
