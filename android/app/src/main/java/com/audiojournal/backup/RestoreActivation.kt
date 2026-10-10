package com.audiojournal.backup

import java.io.File
import java.io.FileOutputStream
import java.nio.channels.FileChannel
import java.nio.file.StandardOpenOption

/**
 * Crash-safe restore activation (§9.10 step 7; owner decision 2026-10-10).
 * Under no-backup storage:
 *
 * - `journal/`, `recordings/`, `recordings-quarantine/`: the live journal;
 * - `vault/vault.bin`: the vault record;
 * - `restore/staging-<hex>/{journal,recordings}`: the staged journal;
 * - `restore/pending-vault.bin`: the record in which the PIN wraps the staged key;
 * - `restore/ACTIVATE`: the marker naming the staging directory;
 * - `restore/previous/`: the old journal, kept until activation is done.
 *
 * Before the marker exists, nothing live has changed. After it, every step is
 * idempotent and [recover] at startup completes it; a failure in this process
 * before the vault record is switched is undone from `previous/`.
 */
object RestoreActivation {
  private val STAGED = listOf("journal", "recordings")
  private const val QUARANTINE = "recordings-quarantine"
  private val STAGING_NAME = Regex("^staging-[0-9a-f]{32}$")

  fun restoreDir(root: File) = File(root, "restore")

  private fun marker(root: File) = File(restoreDir(root), "ACTIVATE")

  private fun pending(root: File) = File(restoreDir(root), "pending-vault.bin")

  private fun vault(root: File) = File(root, "vault/vault.bin")

  /** Steps 1–2: the new vault record, then the marker, each synced. */
  fun begin(root: File, stagingName: String, sealedVaultRecord: ByteArray) {
    require(STAGING_NAME.matches(stagingName)) { "STAGING_NAME" }
    writeSynced(pending(root), sealedVaultRecord)
    writeSynced(marker(root), stagingName.toByteArray(Charsets.US_ASCII))
    syncDir(restoreDir(root))
  }

  /** Steps 3–4; idempotent, so a crash at any point is completed later. */
  fun complete(root: File) {
    val marker = marker(root)
    if (!marker.exists()) return
    val name = marker.readText(Charsets.US_ASCII).trim()
    check(STAGING_NAME.matches(name)) { "ACTIVATION_MARKER" }
    val staging = File(restoreDir(root), name)
    val previous = File(restoreDir(root), "previous").apply { mkdirs() }
    for (part in STAGED) {
      val live = File(root, part)
      val staged = File(staging, part)
      if (staged.exists()) {
        if (live.exists()) moveAside(live, File(previous, part))
        check(staged.renameTo(live)) { "ACTIVATION_RENAME" }
      }
    }
    // The old journal's quarantined files go with it (owner decision:
    // leftovers are discarded together with the old journal).
    File(root, QUARANTINE).takeIf { it.exists() }?.let { moveAside(it, File(previous, QUARANTINE)) }
    syncDir(root)
    val pending = pending(root)
    if (pending.exists()) {
      vault(root).parentFile?.mkdirs()
      check(pending.renameTo(vault(root))) { "ACTIVATION_VAULT" }
      syncDir(vault(root).parentFile!!)
    }
    marker.delete()
    syncDir(restoreDir(root))
    restoreDir(root).deleteRecursively()
  }

  private fun moveAside(live: File, old: File) {
    if (old.exists()) old.deleteRecursively()
    check(live.renameTo(old)) { "ACTIVATION_RENAME" }
  }

  /**
   * Undoes a partial activation in this process while the vault record has
   * not been switched yet: the old journal is put back and the marker
   * removed. Returns false if the vault was already switched (complete it).
   */
  fun undo(root: File): Boolean {
    if (!pending(root).exists()) return false
    val previous = File(restoreDir(root), "previous")
    for (part in STAGED + QUARANTINE) {
      val old = File(previous, part)
      if (!old.exists()) continue
      val live = File(root, part)
      if (live.exists()) live.deleteRecursively()
      check(old.renameTo(live)) { "ACTIVATION_UNDO" }
    }
    syncDir(root)
    marker(root).delete()
    pending(root).delete()
    restoreDir(root).deleteRecursively()
    return true
  }

  /**
   * At process start, before the vault is used: a marked activation is
   * completed; any other restore leftover (staging, a pending record) is
   * deleted. Its key died with the process, so it is unreadable ciphertext.
   */
  fun recover(root: File) {
    if (marker(root).exists()) complete(root) else restoreDir(root).deleteRecursively()
  }

  private fun writeSynced(file: File, bytes: ByteArray) {
    file.parentFile?.mkdirs()
    val temp = File(file.parentFile, "${file.name}.tmp")
    FileOutputStream(temp).use {
      it.write(bytes)
      it.fd.sync()
    }
    check(temp.renameTo(file)) { "ACTIVATION_WRITE" }
  }

  /** Makes renames in [dir] durable (best effort where unsupported). */
  private fun syncDir(dir: File) {
    runCatching { FileChannel.open(dir.toPath(), StandardOpenOption.READ).use { it.force(true) } }
  }
}
