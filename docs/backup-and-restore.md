# Backup and Restore

**Status:** Frozen v0.1 product behavior; archive cryptography and binary format
require a pre-implementation ADR.

## 1. Goal

The user must be able to recover their journal after clearing app data,
uninstalling/reinstalling, losing local application storage, or moving to a new
device. Recovery must not require an Audio Journal account or public backend.

The app provides a manually created, portable, encrypted full-journal backup.
The user chooses where to save it through the operating-system document picker.
That destination may be local Files/Downloads, removable storage, or a cloud
drive the user selected; the app itself does not operate a cloud backup service.

## 2. User-visible operations

### Create backup

1. User opens Settings → Backup & restore → Create backup.
2. App explains the included data, estimated size, and last successful backup.
3. User creates or enters a strong backup password, or records a generated
   recovery key. The local app PIN is not sufficient for offline archive encryption.
4. App creates a consistent encrypted snapshot without stopping ordinary reads.
5. OS document picker asks the user where to save the `.ajbackup` file.
6. App verifies the final file can be reopened, authenticated, and checksummed
   before reporting success.

### Restore backup

1. On a fresh/empty journal, the user creates a new local app PIN.
2. User chooses Restore backup and selects an `.ajbackup` file.
3. User supplies the backup password/recovery key.
4. App authenticates the archive, validates versions and all checksums, then
   shows created date, entry/recording counts, and required storage.
5. After confirmation, app restores into a staging vault, validates it, and
   atomically activates it.
6. User re-enables biometrics and re-pairs the Private AI Node; those credentials
   are deliberately not portable in the archive.

v0.1 restore targets an empty journal. Merge with existing data is Open and must
not be improvised because entry IDs, derivation revisions, and task state can conflict.

## 3. Included data

- Original voice recordings and written entries.
- Transcript segments, corrections, timestamps, and engine revision metadata.
- Derived Work/Personal/Ideas/People/Projects views and their revisions.
- Tasks, completion state, and exact source references/audio ranges.
- Non-sensitive app settings needed to reconstruct the journal experience.
- Schema/format versions, manifest, per-object sizes, and authenticated checksums.

## 4. Excluded data

- Local PIN/passcode verifier and current in-memory unlock session.
- Biometric enrollment, biometric-protected key handles, or raw biometric data.
- Android Keystore/Apple Keychain device-bound keys.
- Hybrid AI node private keys, pairing secrets, trust records, and QR data.
- Logs, developer diagnostics, caches, temporary audio frames, and incomplete AI output.

Excluding device-bound credentials ensures a stolen archive cannot recreate an
authenticated device or node relationship. Restore creates new local security
state and requires node re-pairing.

## 5. Logical archive

```text
AudioJournal-YYYY-MM-DD-HHMM.ajbackup
└── encrypted authenticated payload
    ├── manifest.json
    ├── journal.sqlite.snapshot (or canonical structured export)
    ├── recordings/<recording-id>.<encrypted-media-container>
    └── integrity/index records
```

The manifest includes archive format version, app/schema version, creation time,
object counts, total plaintext/ciphertext sizes, KDF parameters/salt, encryption
metadata, and authenticated per-object digests. It contains no journal plaintext
outside the encrypted authenticated payload.

The `.ajbackup` extension is the target user-facing type. The exact container,
AEAD, KDF, chunking, and streaming format remain Open until the security ADR is
accepted and interoperable Android/iOS fixtures exist.

## 6. Reliability requirements

- Export reads one consistent database snapshot and the exact recording set it references.
- Large recordings stream through bounded memory; no plaintext whole-archive buffer.
- Plaintext staging files are forbidden. Temporary encrypted output uses an
  unpredictable app-private path and is removed after success/cancel/failure.
- Cancellation leaves local journal data unchanged and removes incomplete output.
- The final destination is reported successful only after reopen/authentication/checksum verification.
- Restore validates available disk space, rejects path traversal/duplicate IDs,
  writes to staging, and activates only after full validation.
- A failed restore leaves the existing/empty journal unchanged and presents a
  typed reason without logging archive content or password material.

## 7. UX and reminders

- Settings shows last successful backup date and whether no backup has ever been created.
- After meaningful journal growth, the app may show a quiet local reminder to
  create a new backup. It never claims a backup is current without verifying export success.
- The app clearly states that it cannot recover a forgotten backup password or
  generated recovery key.
- A backup is a snapshot, not synchronization. Newer entries require a new backup.

## 8. Validation gate

- Round-trip exact database/domain records and byte-identical recordings.
- Restore after app-data clear and fresh reinstall on Android and iOS.
- Wrong password, tampered header/manifest/object, truncation, reordering,
  duplicate entry, path traversal, unsupported version, low storage, cancellation,
  and process death at every export/restore phase.
- Cross-platform restore in both directions for the frozen archive version.
- Inspection proves no plaintext journal content exists in output, temporary
  files, logs, crash reports, or OS preview metadata.
