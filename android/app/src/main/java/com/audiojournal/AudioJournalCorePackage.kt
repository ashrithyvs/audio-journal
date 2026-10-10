package com.audiojournal

import com.audiojournal.backup.AudioJournalBackupModule
import com.audiojournal.recording.AudioJournalRecordingsModule
import com.audiojournal.store.AudioJournalStoreModule
import com.audiojournal.vault.AudioJournalVaultModule
import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * App-owned AJ-1 TurboModules (ADR-017): the vault, the encrypted journal
 * store, AJR1 capture and playback, and AJB1 backup and restore.
 */
class AudioJournalCorePackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      when (name) {
        AudioJournalVaultModule.NAME -> AudioJournalVaultModule(reactContext)
        AudioJournalStoreModule.NAME -> AudioJournalStoreModule(reactContext)
        AudioJournalRecordingsModule.NAME -> AudioJournalRecordingsModule(reactContext)
        AudioJournalBackupModule.NAME -> AudioJournalBackupModule(reactContext)
        else -> null
      }

  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
    listOf(
            AudioJournalVaultModule.NAME,
            AudioJournalStoreModule.NAME,
            AudioJournalRecordingsModule.NAME,
            AudioJournalBackupModule.NAME)
        .associateWith {
      ReactModuleInfo(it, it, false, false, false, true)
    }
  }
}
