package com.audiojournal

import com.audiojournal.store.AudioJournalStoreModule
import com.audiojournal.vault.AudioJournalVaultModule
import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/** App-owned AJ-1 TurboModules: the vault and the encrypted journal store (ADR-017). */
class AudioJournalCorePackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      when (name) {
        AudioJournalVaultModule.NAME -> AudioJournalVaultModule(reactContext)
        AudioJournalStoreModule.NAME -> AudioJournalStoreModule(reactContext)
        else -> null
      }

  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
    listOf(AudioJournalVaultModule.NAME, AudioJournalStoreModule.NAME).associateWith {
      ReactModuleInfo(it, it, false, false, false, true)
    }
  }
}
