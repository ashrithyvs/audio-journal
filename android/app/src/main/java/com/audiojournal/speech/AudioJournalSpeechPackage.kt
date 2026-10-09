package com.audiojournal.speech

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class AudioJournalSpeechPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      if (name == AudioJournalSpeechModule.NAME) AudioJournalSpeechModule(reactContext) else null

  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
    mapOf(
        AudioJournalSpeechModule.NAME to
            ReactModuleInfo(
                AudioJournalSpeechModule.NAME,
                AudioJournalSpeechModule.NAME,
                false,
                false,
                false,
                true))
  }
}
