package com.audiojournal.vault

import java.io.File
import java.nio.file.Files
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/** JVM tests of the ADR-017 vault core with fake Keystore and KDF. */
class VaultTest {
  /** Stands in for the Android Keystore device key. */
  private class FakeSealer : DeviceSealer {
    var key: ByteArray? = VaultCrypto.randomBytes(32)

    override fun seal(plaintext: ByteArray): ByteArray {
      val nonce = VaultCrypto.randomBytes(12)
      return nonce + VaultCrypto.seal(key!!, nonce, ByteArray(0), plaintext)
    }

    override fun open(sealed: ByteArray): ByteArray =
        VaultCrypto.open(
            key ?: throw IllegalStateException("device key missing"),
            sealed.copyOfRange(0, 12),
            ByteArray(0),
            sealed.copyOfRange(12, sealed.size))

    override fun delete() {
      key = null
    }
  }

  /** Fast deterministic stand-in for Argon2id; binds every parameter. */
  private val fakeKdf = PinKdf { pin, salt, params ->
    Mac.getInstance("HmacSHA256").run {
      init(SecretKeySpec(salt, "HmacSHA256"))
      update(pin)
      doFinal("${params.memoryKiB}/${params.iterations}/${params.parallelism}".toByteArray())
    }
  }

  private lateinit var dir: File
  private lateinit var file: File
  private val sealer = FakeSealer()
  private var now = 1_000_000L
  private val params = KdfParams(19_456, 2, 1)

  private fun vault(newParams: KdfParams = params) = Vault(file, sealer, fakeKdf, { now }, newParams)

  private fun pin(text: String) = text.toByteArray()

  @Before
  fun setUp() {
    dir = Files.createTempDirectory("vault").toFile()
    file = File(dir, "vault/vault.bin")
  }

  @After
  fun tearDown() {
    dir.deleteRecursively()
  }

  @Test
  fun setupUnlocksAndLockClearsTheKey() {
    val vault = vault()
    assertEquals(VaultState.UNCONFIGURED, vault.state())
    vault.setupPin(pin("482915"))
    assertEquals(VaultState.UNLOCKED, vault.state())
    val dbKey = vault.purposeKey("aj-db-v1")
    vault.lock()
    assertEquals(VaultState.LOCKED, vault.state())
    try {
      vault.purposeKey("aj-db-v1")
      fail("locked vault released a key")
    } catch (_: IllegalStateException) {}
    assertEquals(PinResult.Unlocked, vault.unlockWithPin(pin("482915")))
    assertArrayEquals(dbKey, vault.purposeKey("aj-db-v1"))
    assertFalse(vault.purposeKey("aj-db-v1").contentEquals(vault.purposeKey("aj-rec-v1")))
  }

  @Test
  fun storesNoPinOrMasterKeyInTheClear() {
    val vault = vault()
    vault.setupPin(pin("482915"))
    val stored = file.readBytes()
    val inner = sealer.open(stored)
    assertFalse(String(inner, Charsets.ISO_8859_1).contains("482915"))
    assertFalse(String(stored, Charsets.ISO_8859_1).contains("482915"))
  }

  @Test
  fun appliesTheAttemptPolicyAcrossRestarts() {
    vault().setupPin(pin("482915"))
    var vault = vault()
    repeat(4) { assertEquals(PinResult.WrongPin(null), vault.unlockWithPin(pin("000000"))) }
    assertEquals(PinResult.WrongPin(now + 30_000), vault.unlockWithPin(pin("000000")))
    // A restart keeps the counter; the correct PIN is refused until retryAt.
    vault = vault()
    assertEquals(PinResult.Refused(now + 30_000), vault.unlockWithPin(pin("482915")))
    now += 30_000
    assertEquals(PinResult.WrongPin(now + 60_000), vault.unlockWithPin(pin("111111")))
    now += 60_000
    assertEquals(PinResult.Unlocked, vault.unlockWithPin(pin("482915")))
    vault.lock()
    // Success reset the counter.
    assertEquals(PinResult.WrongPin(null), vault.unlockWithPin(pin("000000")))
  }

  @Test
  fun aClockSetBackNeverShortensALockout() {
    vault().setupPin(pin("482915"))
    val vault = vault()
    vault.lock()
    repeat(5) { vault.unlockWithPin(pin("000000")) }
    now -= 10_000_000
    assertEquals(PinResult.Refused(now + 30_000), vault.unlockWithPin(pin("482915")))
    now += 30_000
    assertEquals(PinResult.Unlocked, vault.unlockWithPin(pin("482915")))
  }

  @Test
  fun lockoutCapsAtOneHour() {
    assertEquals(listOf(0L, 0L, 30_000L, 60_000L, 3_600_000L, 3_600_000L),
        listOf(0, 4, 5, 6, 12, 50).map { Vault.lockoutMs(it) })
  }

  @Test
  fun changingThePinKeepsTheMasterKeyAndTheBiometricCopy() {
    val vault = vault()
    vault.setupPin(pin("482915"))
    val dbKey = vault.purposeKey("aj-db-v1")
    val bioKey = SecretKeySpec(VaultCrypto.randomBytes(32), "AES")
    vault.storeBiometricCopy(Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, bioKey) })
    assertEquals(PinResult.Unlocked, vault.changePin(pin("482915"), pin("917364")))
    vault.lock()
    assertEquals(PinResult.WrongPin(null), vault.unlockWithPin(pin("482915")))
    assertEquals(PinResult.Unlocked, vault.unlockWithPin(pin("917364")))
    assertArrayEquals(dbKey, vault.purposeKey("aj-db-v1"))
    // The biometric copy still opens MK independently of the PIN.
    vault.lock()
    val iv = vault.biometricIv()!!
    val decrypt = Cipher.getInstance("AES/GCM/NoPadding").apply {
      init(Cipher.DECRYPT_MODE, bioKey, GCMParameterSpec(128, iv))
    }
    assertTrue(vault.unlockWithBiometricCipher(decrypt))
    assertArrayEquals(dbKey, vault.purposeKey("aj-db-v1"))
  }

  @Test
  fun removingTheBiometricCopyLeavesThePinWorking() {
    val vault = vault()
    vault.setupPin(pin("482915"))
    val bioKey = SecretKeySpec(VaultCrypto.randomBytes(32), "AES")
    vault.storeBiometricCopy(Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, bioKey) })
    assertTrue(vault.hasBiometricCopy())
    vault.removeBiometricCopy(null)
    assertFalse(vault.hasBiometricCopy())
    assertNull(vault.biometricIv())
    vault.lock()
    assertEquals(PinResult.Unlocked, vault.unlockWithPin(pin("482915")))
  }

  @Test
  fun aTamperedOrUnsealableVaultFailsClosed() {
    vault().setupPin(pin("482915"))
    val bytes = file.readBytes()
    bytes[bytes.size - 1] = (bytes[bytes.size - 1].toInt() xor 1).toByte()
    file.writeBytes(bytes)
    val vault = vault()
    assertEquals(VaultState.UNAVAILABLE, vault.state())
    assertEquals(PinResult.Unavailable, vault.unlockWithPin(pin("482915")))
  }

  @Test
  fun eraseRemovesTheVaultAndTheDeviceKey() {
    val vault = vault()
    vault.setupPin(pin("482915"))
    vault.erase(null)
    assertFalse(file.exists())
    assertNull(sealer.key)
    assertEquals(VaultState.UNCONFIGURED, vault.state())
  }

  @Test
  fun rejectsKdfParametersOutsideThePolicy() {
    try {
      vault(KdfParams(8, 1, 1)).setupPin(pin("482915"))
      fail("weak parameters accepted")
    } catch (_: IllegalArgumentException) {}
    assertFalse(file.exists())
  }

  @Test
  fun rewrapsWithNewParametersOnTheNextUnlock() {
    vault().setupPin(pin("482915"))
    val upgraded = KdfParams(65_536, 3, 1)
    val vault = vault(upgraded)
    assertEquals(PinResult.Unlocked, vault.unlockWithPin(pin("482915")))
    val record = VaultRecord.decode(sealer.open(file.readBytes()))
    assertEquals(upgraded, record.kdf)
    vault.lock()
    assertEquals(PinResult.Unlocked, vault.unlockWithPin(pin("482915")))
  }

  @Test
  fun recordCodecIsStrict() {
    val vault = vault()
    vault.setupPin(pin("482915"))
    val inner = sealer.open(file.readBytes())
    assertNotNull(VaultRecord.decode(inner))
    for (bad in listOf(inner.copyOf(inner.size - 1), inner.copyOf().also { it[0] = 0 }, inner.copyOf().also { it[5] = 2 })) {
      try {
        VaultRecord.decode(bad)
        fail("malformed record accepted")
      } catch (_: IllegalArgumentException) {}
    }
  }

  @Test
  fun hkdfMatchesRfc5869TestCase3() {
    val okm = VaultCrypto.hkdf(ByteArray(22) { 0x0b }, "", 42)
    assertEquals(
        "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8",
        okm.joinToString("") { "%02x".format(it) })
  }
}
