package com.audiojournal.recording

import android.content.Context

/**
 * No test audio input in this build: captures always use the microphone.
 * Only the `e2e` build type (device suites) has a file-backed source.
 */
object TestAudioInput {
  @Suppress("UNUSED_PARAMETER")
  fun sourceOrNull(context: Context): PcmSource? = null
}
