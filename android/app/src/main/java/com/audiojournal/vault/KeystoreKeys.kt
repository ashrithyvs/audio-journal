package com.audiojournal.vault

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private const val ANDROID_KEYSTORE = "AndroidKeyStore"
private const val DEVICE_ALIAS = "aj.vault.device.v1"
private const val BIOMETRIC_ALIAS = "aj.vault.biometric.v1"

private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

private fun generate(spec: KeyGenParameterSpec): SecretKey =
    KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        .apply { init(spec) }
        .generateKey()

private fun baseSpec(alias: String) =
    KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .setRandomizedEncryptionRequired(true)

/**
 * Non-exportable AES-256-GCM device key that seals the vault record to this
 * device (ADR-017). No user authentication: the PIN protects the inner copy.
 * Blob layout: 12-byte IV, then ciphertext and tag.
 */
class KeystoreDeviceSealer : DeviceSealer {
  private fun key(create: Boolean): SecretKey {
    (keyStore().getKey(DEVICE_ALIAS, null) as? SecretKey)?.let { return it }
    check(create) { "device key missing" }
    return generate(baseSpec(DEVICE_ALIAS).build())
  }

  override fun seal(plaintext: ByteArray): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key(create = true))
    return cipher.iv + cipher.doFinal(plaintext)
  }

  override fun open(sealed: ByteArray): ByteArray {
    require(sealed.size > 12 + 16) { "sealed vault too short" }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(
        Cipher.DECRYPT_MODE, key(create = false), GCMParameterSpec(128, sealed.copyOfRange(0, 12)))
    return cipher.doFinal(sealed, 12, sealed.size - 12)
  }

  override fun delete() {
    keyStore().deleteEntry(DEVICE_ALIAS)
  }
}

/**
 * Biometric-bound key for the convenience copy of MK (ADR-017): requires user
 * authentication for every use, BIOMETRIC_STRONG only, and is invalidated by
 * any enrollment change. Used only through a BiometricPrompt CryptoObject.
 */
class KeystoreBiometricKeys(private val context: Context) : BiometricKeys {
  override fun available(): Boolean =
      BiometricManager.from(context).canAuthenticate(BIOMETRIC_STRONG) ==
          BiometricManager.BIOMETRIC_SUCCESS

  override fun create() {
    delete()
    val builder =
        baseSpec(BIOMETRIC_ALIAS)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
    }
    generate(builder.build())
  }

  private fun key(): SecretKey =
      keyStore().getKey(BIOMETRIC_ALIAS, null) as? SecretKey
          ?: throw IllegalStateException("biometric key missing")

  override fun encryptCipher(): Cipher =
      Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }

  override fun decryptCipher(iv: ByteArray): Cipher =
      Cipher.getInstance("AES/GCM/NoPadding").apply {
        init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
      }

  override fun delete() {
    keyStore().deleteEntry(BIOMETRIC_ALIAS)
  }
}
