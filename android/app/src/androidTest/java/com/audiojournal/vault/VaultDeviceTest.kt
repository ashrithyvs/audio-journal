package com.audiojournal.vault

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.audiojournal.store.JournalDatabase
import java.io.File
import net.zetetic.database.sqlcipher.SQLiteDatabase
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * ADR-017 on a device: the real Keystore, the pinned libargon2, and SQLCipher.
 * Each test starts from an erased vault and journal.
 */
@RunWith(AndroidJUnit4::class)
class VaultDeviceTest {
  private val context = InstrumentationRegistry.getInstrumentation().targetContext
  private lateinit var file: File
  private var now = 1_000_000L

  private fun vault() = Vault(file, KeystoreDeviceSealer(), Argon2idKdf(), { now }, VaultHolder.PROVISIONAL_PARAMS)

  @Before
  fun setUp() {
    file = File(context.noBackupFilesDir, "vault-test/vault.bin")
    vault().erase(null)
    JournalDatabase.deleteFiles(context)
  }

  @After
  fun tearDown() {
    JournalDatabase.deleteFiles(context)
    vault().erase(null)
  }

  @Test
  fun keystoreSealingRoundTripsAndRejectsTampering() {
    val sealer = KeystoreDeviceSealer()
    val sealed = sealer.seal("inner".toByteArray())
    assertEquals("inner", String(sealer.open(sealed)))
    sealed[sealed.size - 1] = (sealed[sealed.size - 1].toInt() xor 1).toByte()
    try {
      sealer.open(sealed)
      fail("tampered blob opened")
    } catch (_: Exception) {}
  }

  @Test
  fun libargon2MatchesTheIndependentReference() {
    // Expected tag from tools/ajb1-reference (RFC 9106-checked JS) and the
    // host build of the same pinned libargon2 source.
    val tag = Argon2Native.argon2id(
        "correct horse battery staple".toByteArray(), ByteArray(16) { it.toByte() }, 2, 19_456, 1, 32)
    assertEquals(EXPECTED_REFERENCE_TAG, tag.joinToString("") { "%02x".format(it) })
  }

  @Test
  fun argon2RefusesAbsurdMemoryWithoutCrashing() {
    try {
      Argon2Native.argon2id("x".toByteArray(), ByteArray(16), 1, Int.MAX_VALUE, 1, 32)
      fail("absurd memory accepted")
    } catch (failure: IllegalStateException) {
      assertTrue(failure.message!!.startsWith("ARGON2_"))
    }
  }

  @Test
  fun pinLifecycleWithRealKeystoreAndArgon2() {
    val vault = vault()
    vault.setupPin("482915".toByteArray())
    val dbKey = vault.purposeKey("aj-db-v1")
    vault.lock()
    assertEquals(PinResult.WrongPin(null), vault.unlockWithPin("000000".toByteArray()))
    assertEquals(PinResult.Unlocked, vault().unlockWithPin("482915".toByteArray()))
    val reopened = vault()
    reopened.unlockWithPin("482915".toByteArray())
    assertTrue(dbKey.contentEquals(reopened.purposeKey("aj-db-v1")))
    assertFalse(String(file.readBytes(), Charsets.ISO_8859_1).contains("482915"))
  }

  @Test
  fun journalDatabaseIsEncryptedAtRest() {
    val vault = vault()
    vault.setupPin("482915".toByteArray())
    JournalDatabase.open(context, vault)
    JournalDatabase.run("CREATE TABLE t (x TEXT) STRICT", "[]")
    JournalDatabase.run("INSERT INTO t (x) VALUES (?)", "[\"PLAINTEXT-CANARY-7731\"]")
    assertEquals("[{\"x\":\"PLAINTEXT-CANARY-7731\"}]", JournalDatabase.all("SELECT x FROM t", "[]"))
    JournalDatabase.close()
    val bytes = listOf("", "-wal").flatMap {
      File(JournalDatabase.file(context).path + it).takeIf { f -> f.exists() }?.readBytes()?.toList() ?: emptyList()
    }.toByteArray()
    val text = String(bytes, Charsets.ISO_8859_1)
    assertFalse("canary in database bytes", text.contains("PLAINTEXT-CANARY-7731"))
    assertFalse("plaintext SQLite header", text.startsWith("SQLite format 3"))
    // A wrong raw key cannot read it.
    System.loadLibrary("sqlcipher")
    val wrong = "x'${"00".repeat(32)}'".toByteArray()
    try {
      SQLiteDatabase.openOrCreateDatabase(JournalDatabase.file(context).path, wrong, null, null, null)
          .use { it.rawQuery("SELECT count(*) FROM t").use { c -> c.moveToFirst() } }
      fail("wrong key opened the journal")
    } catch (failure: Exception) {
      // The failure must be the key, not anything incidental.
      assertTrue(
          "unexpected failure: ${failure.javaClass.name}: ${failure.message}",
          "${failure.javaClass.simpleName} ${failure.message}".contains("not a database", ignoreCase = true) ||
              failure.javaClass.simpleName.contains("NotADatabase"))
    }
    // Locking closes it; the store refuses until reopened.
    vault.lock()
    try {
      JournalDatabase.all("SELECT 1", "[]")
      fail("closed store answered")
    } catch (failure: IllegalStateException) {
      assertEquals("STORE_LOCKED", failure.message)
    }
  }

  companion object {
    /** Confirmed by the JS reference and the host build of libargon2 (crosscheck.sh). */
    const val EXPECTED_REFERENCE_TAG = "818259b6310026a8e0dbac5d2e6927abcfdb07b32258fac4f61b18b80f929085"
  }
}
