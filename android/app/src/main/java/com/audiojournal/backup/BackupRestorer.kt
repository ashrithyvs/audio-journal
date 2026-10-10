package com.audiojournal.backup

import com.audiojournal.vault.KdfParams
import com.audiojournal.vault.VaultCrypto
import java.io.InputStream

/** A user-chosen archive that can be read from the start more than once. */
interface ArchiveSource {
  val size: Long

  fun open(): InputStream
}

/** The backup secret's KDF: libargon2 Argon2id in production (ADR-017). */
fun interface ArchiveKdf {
  fun derive(secret: ByteArray, salt: ByteArray, params: KdfParams): ByteArray
}

/**
 * AJB1 restore (§9.10). [open] runs every pre-KDF check, the KDF, the unwrap,
 * a full authentication pass, and reads the manifest for the preview. [stage]
 * then streams the archive into a staging sink; every segment is
 * authenticated again as it is read, so a file that changed between the
 * passes still fails safely.
 */
class BackupRestorer(
    private val kdf: ArchiveKdf,
    private val policy: Ajb1.KdfPolicy = Ajb1.KdfPolicy.PROVISIONAL,
    private val limits: Ajb1.Limits = Ajb1.Limits.V1,
) {
  class Opened(
      val header: ByteArray,
      val info: Ajb1.HeaderInfo,
      private var dek: ByteArray?,
      val manifest: Map<String, Any>,
      val archiveBytes: Long,
  ) : AutoCloseable {
    fun key(): ByteArray = dek ?: throw IllegalStateException("AJB1_CLOSED")

    override fun close() {
      VaultCrypto.zero(dek)
      dek = null
    }
  }

  private fun header(source: ArchiveSource): ByteArray =
      source.open().use { input ->
        val out = ByteArray(minOf(source.size, Ajb1.HEADER_BYTES.toLong()).toInt())
        var at = 0
        while (at < out.size) {
          val count = input.read(out, at, out.size - at)
          if (count < 0) break
          at += count
        }
        out.copyOf(at)
      }

  private fun body(source: ArchiveSource): InputStream {
    val input = source.open()
    var skipped = 0L
    while (skipped < Ajb1.HEADER_BYTES) {
      val count = input.skip(Ajb1.HEADER_BYTES - skipped)
      if (count <= 0) {
        if (input.read() < 0) throw Ajb1.Failure("TRUNCATED", "header")
        skipped += 1
      } else {
        skipped += count
      }
    }
    return input
  }

  /** Throws [Ajb1.Failure] with the §9.10 code and stage. */
  fun open(
      source: ArchiveSource,
      secretKind: Int,
      secret: ByteArray,
      availableBytes: Long,
      checkpoint: (String) -> Unit = {},
  ): Opened {
    val header = header(source)
    val info =
        Ajb1.precheck(
            header, source.size, secretKind, policy, restoreAvailableBytes = availableBytes, limits = limits)
    checkpoint("prechecked")
    val kek = kdf.derive(secret, info.salt, info.kdf)
    val dek =
        try {
          Ajb1.unwrapDek(header, kek)
        } finally {
          VaultCrypto.zero(kek)
        }
    try {
      val bodyBytes = source.size - Ajb1.HEADER_BYTES
      body(source).use { SegmentReader(it, header, dek, info.segments, bodyBytes).authenticateAll() }
      checkpoint("authenticated")
      val manifest =
          body(source).use {
            Ajb1Parser(SegmentReader(it, header, dek, info.segments, bodyBytes), info.domainSchemaVersion, limits)
                .manifestOnly()
          }
      return Opened(header, info, dek, manifest, source.size)
    } catch (failure: Throwable) {
      VaultCrypto.zero(dek)
      throw failure
    }
  }

  /** Streams and validates the whole archive into [sink]. */
  fun stage(
      source: ArchiveSource,
      opened: Opened,
      sink: ArchiveSink,
      checkpoint: (String) -> Unit = {},
  ) {
    body(source).use {
      val reader =
          SegmentReader(it, opened.header, opened.key(), opened.info.segments, source.size - Ajb1.HEADER_BYTES)
      try {
        Ajb1Parser(reader, opened.info.domainSchemaVersion, limits, checkpoint).parse(sink)
      } finally {
        reader.close()
      }
    }
  }
}
