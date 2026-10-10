package com.audiojournal.backup

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Crash-safe restore activation (§9.10 step 7; owner decision 2026-10-10). */
class RestoreActivationTest {
  private lateinit var root: File
  private val staging = "staging-" + "a".repeat(32)

  private fun write(path: String, text: String) =
      File(root, path).apply {
        parentFile?.mkdirs()
        writeText(text)
      }

  private fun read(path: String) = File(root, path).takeIf { it.exists() }?.readText()

  @Before
  fun setUp() {
    root = Files.createTempDirectory("activation").toFile()
    // The old, empty-looking journal with a tombstone and a quarantined file.
    write("journal/journal.db", "old db")
    write("recordings/rec_old.ajr", "old failed artifact")
    write("recordings-quarantine/1-x.ajr", "old quarantine")
    write("vault/vault.bin", "old vault")
    // A fully staged restore.
    write("restore/$staging/journal/journal.db", "new db")
    write("restore/$staging/recordings/rec_new.ajr", "new audio")
  }

  @After
  fun tearDown() {
    root.deleteRecursively()
  }

  private fun assertActivated() {
    assertEquals("new db", read("journal/journal.db"))
    assertEquals("new audio", read("recordings/rec_new.ajr"))
    assertEquals(null, read("recordings/rec_old.ajr"))
    assertFalse(File(root, "recordings-quarantine").exists())
    assertEquals("new vault", read("vault/vault.bin"))
    assertFalse(File(root, "restore").exists())
  }

  private fun assertUnchanged() {
    assertEquals("old db", read("journal/journal.db"))
    assertEquals("old failed artifact", read("recordings/rec_old.ajr"))
    assertEquals("old quarantine", read("recordings-quarantine/1-x.ajr"))
    assertEquals("old vault", read("vault/vault.bin"))
  }

  @Test
  fun activatesEverythingTogether() {
    RestoreActivation.begin(root, staging, "new vault".toByteArray())
    RestoreActivation.complete(root)
    assertActivated()
  }

  @Test
  fun aCrashBeforeTheMarkerLeavesThePreRestoreVaultUnchanged() {
    // Staged, but the process died before the marker: the key died with it.
    RestoreActivation.recover(root)
    assertUnchanged()
    assertFalse(File(root, "restore").exists())
  }

  @Test
  fun aCrashAfterTheMarkerIsCompletedAtStartupFromAnyStep() {
    // Simulate a crash after each rename of complete(): recover() finishes it.
    for (step in 0..3) {
      setUp()
      RestoreActivation.begin(root, staging, "new vault".toByteArray())
      if (step >= 1) File(root, "journal").renameTo(File(root, "restore/previous/journal").apply { parentFile.mkdirs() })
      if (step >= 2) File(root, "restore/$staging/journal").renameTo(File(root, "journal"))
      if (step >= 3) {
        File(root, "recordings").renameTo(File(root, "restore/previous/recordings"))
        File(root, "restore/$staging/recordings").renameTo(File(root, "recordings"))
      }
      RestoreActivation.recover(root)
      assertActivated()
      root.deleteRecursively()
    }
  }

  @Test
  fun aFailureInProcessBeforeTheVaultSwitchIsUndone() {
    RestoreActivation.begin(root, staging, "new vault".toByteArray())
    // Part of the swap happened, then an error: put the old journal back.
    File(root, "journal").renameTo(File(root, "restore/previous/journal").apply { parentFile.mkdirs() })
    File(root, "restore/$staging/journal").renameTo(File(root, "journal"))
    assertTrue(RestoreActivation.undo(root))
    assertUnchanged()
    assertFalse(File(root, "restore").exists())
    // Nothing is left to complete at the next start.
    RestoreActivation.recover(root)
    assertUnchanged()
  }

  @Test
  fun refusesAMarkerThatNamesSomethingElse() {
    try {
      RestoreActivation.begin(root, "../vault", ByteArray(1))
      throw AssertionError("accepted a path")
    } catch (_: IllegalArgumentException) {}
    write("restore/ACTIVATE", "../../journal")
    try {
      RestoreActivation.complete(root)
      throw AssertionError("followed a path")
    } catch (_: IllegalStateException) {}
    assertEquals("old db", read("journal/journal.db"))
  }
}
