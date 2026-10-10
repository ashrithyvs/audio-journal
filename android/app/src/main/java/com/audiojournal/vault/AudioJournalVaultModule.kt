package com.audiojournal.vault

import android.security.keystore.KeyPermanentlyInvalidatedException
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.audiojournal.specs.NativeAudioJournalVaultSpec
import com.audiojournal.store.JournalDatabase
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.UiThreadUtil
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import javax.crypto.Cipher
import org.json.JSONObject

/**
 * TurboModule over the ADR-017 vault. Results carry outcomes only; the master
 * key, KEKs, and biometric material never leave native code, and nothing is
 * logged. Locking or erasing closes the journal database first.
 */
class AudioJournalVaultModule(private val context: ReactApplicationContext) :
    NativeAudioJournalVaultSpec(context) {

  private val executor = Executors.newSingleThreadExecutor()
  private val vault by lazy { VaultHolder.get(context) }
  private val biometric by lazy { KeystoreBiometricKeys(context) }

  override fun getName() = NAME

  private fun pinBytes(pin: String) = pin.toByteArray(Charsets.UTF_8)

  private fun result(name: String, retryAt: Long? = null): String =
      JSONObject().put("result", name).apply { retryAt?.let { put("retryAt", it) } }.toString()

  private fun pinResult(outcome: PinResult): String =
      when (outcome) {
        PinResult.Unlocked -> result("unlocked")
        is PinResult.WrongPin -> result("wrong_pin", outcome.retryAt)
        is PinResult.Refused -> result("refused", outcome.retryAt)
        PinResult.Unavailable -> result("unavailable")
      }

  /** Probes the biometric copy; an invalidated key is removed here. */
  private fun biometricState(): String {
    if (!vault.hasBiometricCopy()) return if (biometric.available()) "off" else "not_available"
    val iv = vault.biometricIv() ?: return "off"
    return try {
      biometric.decryptCipher(iv)
      if (biometric.available()) "on" else "not_available"
    } catch (_: KeyPermanentlyInvalidatedException) {
      vault.removeBiometricCopy(biometric)
      "invalidated"
    } catch (_: Exception) {
      vault.removeBiometricCopy(biometric)
      "invalidated"
    }
  }

  override fun status(promise: Promise) {
    executor.execute {
      val json = JSONObject()
      when (vault.state()) {
        VaultState.UNCONFIGURED -> json.put("state", "unconfigured")
        VaultState.UNAVAILABLE -> json.put("state", "unavailable")
        VaultState.LOCKED ->
            json.put("state", "locked").put("biometric", biometricState()).apply {
              vault.retryAt()?.let { put("retryAt", it) }
            }
        VaultState.UNLOCKED -> json.put("state", "unlocked").put("biometric", biometricState())
      }
      promise.resolve(json.toString())
    }
  }

  override fun setupPin(pin: String, promise: Promise) {
    executor.execute {
      val bytes = pinBytes(pin)
      try {
        vault.setupPin(bytes)
        promise.resolve(null)
      } catch (_: Exception) {
        promise.reject("LOCK_KEY_UNAVAILABLE", "LOCK_KEY_UNAVAILABLE")
      } finally {
        VaultCrypto.zero(bytes)
      }
    }
  }

  override fun unlockWithPin(pin: String, promise: Promise) {
    executor.execute {
      val bytes = pinBytes(pin)
      try {
        promise.resolve(pinResult(vault.unlockWithPin(bytes)))
      } catch (_: Exception) {
        promise.resolve(result("unavailable"))
      } finally {
        VaultCrypto.zero(bytes)
      }
    }
  }

  override fun changePin(currentPin: String, nextPin: String, promise: Promise) {
    executor.execute {
      val current = pinBytes(currentPin)
      val next = pinBytes(nextPin)
      try {
        promise.resolve(pinResult(vault.changePin(current, next)))
      } catch (_: Exception) {
        promise.resolve(result("unavailable"))
      } finally {
        VaultCrypto.zero(current, next)
      }
    }
  }

  override fun lock(promise: Promise) {
    executor.execute {
      JournalDatabase.close()
      vault.lock()
      promise.resolve(null)
    }
  }

  override fun erase(confirmation: String, promise: Promise) {
    executor.execute {
      if (confirmation != "ERASE") {
        promise.reject("ERASE_NOT_CONFIRMED", "ERASE_NOT_CONFIRMED")
        return@execute
      }
      JournalDatabase.deleteFiles(context)
      File(context.noBackupFilesDir, "recordings").deleteRecursively()
      vault.erase(biometric)
      promise.resolve(null)
    }
  }

  override fun disableBiometric(promise: Promise) {
    executor.execute {
      vault.removeBiometricCopy(biometric)
      promise.resolve(null)
    }
  }

  override fun unlockWithBiometric(promise: Promise) {
    executor.execute {
      val iv = vault.biometricIv()
      if (iv == null || !biometric.available()) {
        promise.resolve(result("not_available"))
        return@execute
      }
      val cipher =
          try {
            biometric.decryptCipher(iv)
          } catch (_: Exception) {
            // Enrollment changed: drop the copy; the PIN copy is unaffected.
            vault.removeBiometricCopy(biometric)
            promise.resolve(result("invalidated"))
            return@execute
          }
      prompt(cipher, promise) { authorized ->
        if (vault.unlockWithBiometricCipher(authorized)) result("unlocked") else result("failed")
      }
    }
  }

  override fun enableBiometric(promise: Promise) {
    executor.execute {
      if (vault.state() != VaultState.UNLOCKED || !biometric.available()) {
        promise.resolve(result("not_available"))
        return@execute
      }
      val cipher =
          try {
            biometric.create()
            biometric.encryptCipher()
          } catch (_: Exception) {
            promise.resolve(result("not_available"))
            return@execute
          }
      prompt(cipher, promise) { authorized ->
        vault.storeBiometricCopy(authorized)
        result("unlocked")
      }
    }
  }

  /** Shows a cryptographic BiometricPrompt; settles the promise exactly once. */
  private fun prompt(cipher: Cipher, promise: Promise, onAuthorized: (Cipher) -> String) {
    val settled = AtomicBoolean(false)
    fun settle(json: String) {
      if (settled.compareAndSet(false, true)) promise.resolve(json)
    }
    val activity = context.currentActivity as? FragmentActivity
    if (activity == null) {
      settle(result("not_available"))
      return
    }
    UiThreadUtil.runOnUiThread {
      val callback =
          object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(outcome: BiometricPrompt.AuthenticationResult) {
              val authorized = outcome.cryptoObject?.cipher
              executor.execute {
                settle(
                    if (authorized == null) result("failed")
                    else
                        try {
                          onAuthorized(authorized)
                        } catch (_: Exception) {
                          result("failed")
                        })
              }
            }

            override fun onAuthenticationError(code: Int, message: CharSequence) {
              settle(
                  when (code) {
                    BiometricPrompt.ERROR_NEGATIVE_BUTTON,
                    BiometricPrompt.ERROR_USER_CANCELED,
                    BiometricPrompt.ERROR_CANCELED -> result("cancelled")
                    BiometricPrompt.ERROR_LOCKOUT,
                    BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> result("failed")
                    else -> result("not_available")
                  })
            }
          }
      val info =
          BiometricPrompt.PromptInfo.Builder()
              .setTitle("Unlock your journal")
              .setNegativeButtonText("Use PIN")
              .setAllowedAuthenticators(BIOMETRIC_STRONG)
              .build()
      BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback)
          .authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }
  }

  companion object {
    const val NAME = "AudioJournalVault"
  }
}
