package com.audiojournal.vault

import android.content.Context
import java.io.File

/** One vault per process, shared by the vault and store modules. */
object VaultHolder {
  /**
   * Argon2id parameters for new or rewrapped PIN copies. PROVISIONAL: frozen
   * only after the lowest-supported physical-device benchmark (ADR-017,
   * Open decision 1). Existing vaults are rewrapped on the next PIN unlock
   * when these change.
   */
  val PROVISIONAL_PARAMS = KdfParams(memoryKiB = 19_456, iterations = 2, parallelism = 1)

  @Volatile private var vault: Vault? = null

  fun vaultFile(context: Context) = File(context.noBackupFilesDir, "vault/vault.bin")

  fun get(context: Context): Vault =
      vault
          ?: synchronized(this) {
            vault
                ?: Vault(
                        vaultFile(context),
                        KeystoreDeviceSealer(),
                        Argon2idKdf(),
                        System::currentTimeMillis,
                        PROVISIONAL_PARAMS)
                    .also { vault = it }
          }
}
