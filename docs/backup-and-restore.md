# Backup and Restore

**Status:** Frozen v0.1 product behavior. The cryptography is ADR-017. The
binary format is frozen for implementation in §9; Argon2id parameters stay
provisional.

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


## 9. AJB1 binary format (container v1, domain schema v1)

**Status:** **Frozen for implementation** (owner conditional approval of
2026-10-10, after its conditions passed on 2026-10-10). Frozen: the binary
layout, canonicalization, schemas, and reader/writer behaviour.

**Freeze evidence:**

- **Reproducible generation.** `node tools/ajb1-reference/generate-vectors.mjs
  --check` regenerates all 43 files byte for byte.
- **Independent verification.** `python3 -I tools/ajb1-reference/verify_vectors.py
  schemas/ajb1/v1` was written from this text, not ported. It uses Python's
  JSON parser, `cryptography` AES-GCM, and OpenSSL Argon2id. It reaches the
  recorded verdict on all 81 vectors.
- **RFC 9106.** The reference Argon2 matches the Argon2d, Argon2i, and
  Argon2id test vectors.
- **libargon2.** The pinned native libargon2 (20190702, SHA-256 verified)
  matches the reference on the host in 11 cases, including every vector KEK,
  and on the Android emulator in `VaultDeviceTest`.
- **Valid and hostile vectors.** Valid, wrong-secret, header, KDF-bound,
  layout, truncation, segment-tampering, canonical-JSON, record, reference,
  section, and storage cases.
- **Cancellation and cleanup.** `test/procedure.test.mjs` cancels export and
  restore at every phase, scans temporary and staging files for plaintext
  canaries, and covers failure and stale-file cleanup.
- **Builds.** The host JS baseline and the Gradle builds are clean.

**Still provisional, and not part of the freeze:**

- **Argon2id parameters.** The production floor, default, and ceiling are
  injectable policy values. They are frozen only from the lowest-supported
  **physical** Android device benchmark (ADR-017); emulator measurements
  are never used.
- **The vectors' parameters.** The vectors use provisional values and are
  regenerated when the parameters freeze.

**Reference implementation.** `tools/ajb1-reference/` is the executable
form of this section. The production Android codec follows it and must pass
these vectors and the procedure tests.

All integers are unsigned big-endian unless stated otherwise.

### 9.1 Two independent versions

- **Container version.** The header `formatVersion` (currently `1`)
  covers the cryptography, header, segmenting, section framing, and
  manifest shape. Only a new container version changes them.
- **Domain schema version.** The header `domainSchemaVersion`, which the
  manifest repeats, names the record types and their fields:
  - Version `1` (AJ-1) has `entry`, `recording`, and `transcriptSegment`.
  - Version `2` is reserved for AJ-2. It adds `derivation`, `task`, and
    `sourceReference`, frozen with `journal.organize@1`, and needs no
    change to the container.
  - A reader supports domain versions `1..N`. It upgrades older records
    on import and rejects newer ones (`UNSUPPORTED_SCHEMA`) before any KDF
    work.
  - The domain version is independent of local SQLite migration numbers;
    export maps the local schema to the current domain version.
- **Authentication.** Both versions are in the header, so they are bound
  by the DEK-wrap AAD and the header hash. The manifest must repeat them
  exactly.

### 9.2 Header (128 bytes, plaintext, authenticated)

| Offset | Size | Field | v1 rule |
|---:|---:|---|---|
| 0 | 8 | magic | `41 4A 42 31 0D 0A 1A 0A` |
| 8 | 2 | `formatVersion` | `1` |
| 10 | 2 | header length | `128` |
| 12 | 1 | KDF algorithm | `1` = Argon2id |
| 13 | 1 | KDF version | `0x13` |
| 14 | 1 | parallelism `p` | within the accepted floor and ceiling |
| 15 | 1 | reserved | `0` |
| 16 | 4 | memory `m` (KiB) | within the floor and ceiling; `m ≥ 8p` |
| 20 | 4 | iterations `t` | within the floor and ceiling |
| 24 | 16 | KDF salt | random |
| 40 | 1 | AEAD | `1` = AES-256-GCM |
| 41 | 1 | secret kind | `1` = password, `2` = recovery key (§9.7) |
| 42 | 2 | `domainSchemaVersion` | `≥ 1` |
| 44 | 4 | segment length `L` | `1 048 576` |
| 48 | 4 | stream nonce prefix | random |
| 52 | 12 | DEK wrap nonce | random |
| 64 | 48 | wrapped DEK | `AES-256-GCM(KEK, wrapNonce, aad = header[0..64), DEK)`: 32-byte ciphertext and 16-byte tag |
| 112 | 16 | reserved | zero |

- **KEK.** `Argon2id(secret, salt, t, m, p, tag 32, v 0x13)`, with no
  secret value K and no associated data X.
- **DEK.** 32 random bytes per archive.
- **Header hash.** `headerHash = SHA-256(header[0..128))`.

### 9.3 Segments

The plaintext stream is cut into full segments of exactly `L` bytes,
followed by **one final segment of 0 to `L − 1` bytes**. A stream whose
length is a multiple of `L` therefore ends with an empty final segment.
This makes the layout unique for a given plaintext.

Each segment `i` is stored as AES-256-GCM ciphertext followed by its tag:

- `nonce = noncePrefix || u64(i)`;
- `aad = headerHash || u64(i) || u8(final)`.

**On disk:** the header, then `n` blocks of `L + 16` bytes, then a final
block of 16 to `L + 15` bytes.

**Reader results:**

- A body whose length modulo `L + 16` is below 16 is `TRUNCATED`, before
  the KDF. This includes the case where the final block was dropped.
- Any tag failure is `AUTH_FAILED`. This covers reordering, duplication,
  dropped middle segments, mid-segment truncation, trailing bytes,
  splicing from another archive, and header tampering.

### 9.4 Canonical JSON and NDJSON ("AJ canonical JSON v1")

The profile is RFC 8785 (JCS), narrowed so that independent
implementations produce identical bytes:

- **Encoding.** UTF-8 without a BOM. Strings must be well-formed Unicode;
  unpaired surrogates are rejected.
- **Values.** Objects, arrays, strings, `true`/`false`, and integers from
  0 to 2^53 − 1 in plain decimal: no sign, fraction, exponent, or leading
  zero.
  - `null` is forbidden. An absent optional field is **omitted**.
- **Serialization.** JCS:
  - no insignificant whitespace;
  - object members sorted by UTF-16 code units;
  - strings escape only `"`, `\`, and U+0000–U+001F, using `\b \t \n \f
    \r` or lower-case `\u00xx`;
  - every other character is written literally, including `/`, U+007F,
    and non-ASCII.
- **Timestamps.** Integer milliseconds since the Unix epoch, UTC. Field
  names end in `AtMs`. Offsets are integer milliseconds (`…Ms`).
- **Unicode normalization: none.** Titles, written text, and transcript
  text are preserved code unit for code unit. Only passwords are
  normalized (NFC, §9.7). IDs, enums, and model IDs are ASCII.
- **NDJSON.** One canonical object per line, each followed by exactly one
  LF (0x0A). No CR, no empty lines, and a final LF. An empty section is
  zero bytes.
- **Strict decoding.** A document or line is accepted only if all of the
  following hold; otherwise it is `NON_CANONICAL_JSON`:
  - it is valid UTF-8;
  - it parses with **no duplicate key at any depth**;
  - it uses only the value types above;
  - it re-serializes to exactly its original bytes.

  The round-trip rule rejects whitespace, key order, escape, and number
  variants. Unknown fields and unknown record types are `INVALID_RECORD`,
  or `MALFORMED_MANIFEST` in the manifest.

### 9.5 Sections and manifest

The decrypted stream is a strict sequence of sections:

`kind u8 · reserved u8[3] = 0 · length u64 · body`

| Order | Kind | Body |
|---|---|---|
| 1 | `1` MANIFEST | Canonical JSON, at most 64 KiB |
| 2 | `2` RECORDS | Canonical NDJSON of all records (§9.6). Length and SHA-256 equal the manifest's. |
| 3… | `3` RECORDING | One per recording record, in ascending recording-ID byte order: a 30-byte ASCII ID, then PCM s16le 16 kHz mono. The length equals `30 + pcmBytes` and the SHA-256 equals `pcmSha256`. |
| last | `4` END | Empty. The stream ends exactly here. |

**The manifest has a fixed shape.** It has exactly these keys, so its
size does not grow with the journal:

```json
{"createdAtMs":1760000600000,"domainSchemaVersion":1,"format":"AJB1","formatVersion":1,
 "pcm":{"bytes":2120000,"recordings":2},
 "records":{"bytes":3121,"counts":{"entry":3,"recording":2,"transcriptSegment":6},
            "lines":11,"sha256":"…"}}
```

(The example is wrapped for reading; the stored form is one canonical
line.)

**Manifest rules:**

- `counts` lists exactly the record types of the declared domain version,
  zeros included.
- `lines` equals the sum of the counts.
- `pcm.recordings` equals `counts.recording`.
- `pcm.bytes` equals the sum of `pcmBytes`.

**No per-recording list in the manifest.** Recording sizes and digests
live in the recording records. The RECORDS section precedes all PCM, so a
restore validates every record, ID, reference, count, and size before
staging any audio. This also reconciles the manifest cap with the
recording cap.

### 9.6 Domain schema v1 records

**Order.** Records are ordered by type (`entry`, `recording`,
`transcriptSegment`), then by `id` byte order.

**IDs.** IDs use the app format: `ent_`, `rec_`, or `seg_`, followed by
26 Crockford base32 characters.

| `t` | Required fields | Optional fields | Rules |
|---|---|---|---|
| `entry` | `id`, `kind` (`voice`, `written`), `status` (`ready`, `recovery_required`), `createdAtMs`, `updatedAtMs` | `title`, `sourceText` | `updatedAtMs ≥ createdAtMs`.<br>`title` is 1–200 UTF-16 units, already whitespace-collapsed.<br>`sourceText` is present only for written entries: 1–200 000 UTF-16 units, not blank, stored exactly. |
| `recording` | `id`, `entryId`, `state` (`ready`, `recoverable`), `startedAtMs`, `durationMs` (at most 3 600 000), `pcmBytes`, `pcmSha256` | `endedAtMs`, `finishReason` | A `ready` recording requires both optional fields.<br>`pcmBytes` is even, greater than 0, and within 32 bytes of `durationMs × 32`. |
| `transcriptSegment` | `id`, `entryId`, `recordingId`, `engineRevision`, `ordinal`, `startMs`, `endMs`, `text` (at most 4 000 units), `state`, `source`, `createdAtMs` | `modelId`, `supersedesSegmentId` | Mirrors schema v1:<br>- `corrected` ⇔ `user` ⇔ `supersedesSegmentId` present<br>- `provisional` ⇔ revision 0<br>- `final` ⇔ `modelId` present |

**Cross-record rules**, checked after RECORDS and before any PCM:

- IDs are unique (`DUPLICATE_ID`).
- Each voice entry has exactly one recording, and each recording belongs
  to a voice entry (`DANGLING_REFERENCE`).
- A segment's `endMs` does not exceed its recording's `durationMs`.
- A correction supersedes a non-live segment of the same recording and
  revision, and no segment is superseded twice.
- Live (`provisional`) rows appear only for recordings with no full pass.

**Exported:**

- entries that are `ready` or `recovery_required` and have their source;
- recordings that are `ready` or `recoverable`;
- all `final` and `corrected` segments;
- live segments only where no full pass exists, and never superseded
  ones.

**Not exported:**

- drafts and tombstoned (deleted or discarded) entries, failed
  recordings, and superseded live rows (owner decision, 2026-10-10);
- AJR1 container fields: `sealedChunks`, `byteCount`, `relativePath`;
- everything in §4.

### 9.7 Secrets

**Password (secret kind 1).** The password is NFC-normalized, then
encoded as UTF-8 for the KDF. It must be at least 12 Unicode code points and
at most 1 024 bytes; otherwise it is rejected with `WEAK_PASSWORD` or
`TOO_LONG`. The 12-code-point rule is a **minimum input rule only**: meeting
it does not show that a password is strong. The UI recommends the generated
recovery key or a long passphrase, and never calls a password "strong" just
because it passed this check.

**Recovery key (secret kind 2):**

- **Entropy.** 256 bits from the platform CSPRNG.
- **Display.** The key is shown as **24 words from the BIP-39 English
  wordlist**:
  - wordlist ID `bip39-english`, MIT licence;
  - 2 048 lines, SHA-256 `2f5eed53…b24dbda`, pinned in the app and the
    tool.
- **Checksum.** The first 8 bits of SHA-256 of the entropy (the BIP-39
  checksum). Each word encodes 11 bits.
- **Canonical form.** Lower-case words separated by single spaces.
- **Decoding:**
  - trim, ASCII-lowercase, and split on Unicode whitespace;
  - there must be exactly 24 tokens (`WORD_COUNT`);
  - each token must be an exact wordlist word (`UNKNOWN_WORD`, with its
    position);
  - the checksum must match (`CHECKSUM`).

  No other leniency, such as prefixes or Unicode case folding, is
  allowed.
- **KDF input.** The 32 entropy bytes. A BIP-39 PBKDF2 seed is never
  derived.
- **New lists.** A different wordlist or length is a new secret kind.

### 9.8 v0.1 limits

These limits are internally consistent and accepted in principle (owner,
2026-10-10). The 34 GiB archive and 32 GiB PCM figures are **parser and
archive safety ceilings**. They do not claim that every supported device
can process an archive that large in practice; free-space checks and
device-profile acceptance decide that.

| Item | Limit | Checked |
|---|---|---|
| Archive file | 34 GiB | From the file size, before the KDF |
| Free space to restore | archive size + 512 MiB | Before the KDF, and again before staging |
| Free space to export | estimated archive size + 256 MiB | Before the KDF and before writing |
| Manifest | 64 KiB | From the section length, before reading |
| RECORDS section | 1 GiB; one line at most 2 MiB | From the length; then per line |
| Entries | 100 000 | From the manifest |
| Recordings | 100 000 (each voice entry has one) | From the manifest |
| Transcript segment records | 4 000 000 | From the manifest |
| One recording | 115 200 032 bytes of PCM (60 min + 1 ms) | From the record |
| Total PCM | 32 GiB (about 298 h) | From the manifest |
| Argon2id (provisional vector values) | `m` 19 456–1 048 576 KiB, `t` 2–10, `p` 1–4 | From the header, before allocation |

**Argon2id parameters stay provisional.** The production floor, default, and
ceiling remain provisional and **injectable**. The reader and writer take
them as a policy value, never as constants. They are frozen only from the
lowest-supported **physical** Android device benchmark (ADR-017). Emulator
measurements are never used to set production values. The vectors use the
provisional values above and are regenerated when the benchmark freezes
the real ones.

**Why these are consistent:**

- The manifest is fixed-shape, so its cap does not depend on any count.
- 32 GiB of PCM plus 1 GiB of records, framing (12 bytes per section),
  and tags (16 bytes per MiB) stays under 34 GiB.
- The 2 MiB line cap holds the largest legal record: 200 000 UTF-16 units
  at up to 6 bytes each when escaped.

**At export.** Create backup applies the same aggregate limits and
reports `LIMIT_EXCEEDED`, with the journal's size, before any KDF work.
A journal larger than the limits cannot be backed up as one v0.1
archive; how the app warns about that is an owner UX decision.

### 9.9 Round-trip meaning

"Byte-identical recording round-trip" means:

- the restored **PCM** is identical (the same `pcmSha256`);
- written text and every record re-export to the same canonical NDJSON.

The following differ by design: AJR1 ciphertext, salts, nonces, and keys
(the restored vault has new keys), and local paths and AJR1 chunk
counters.

### 9.10 Reader order, cancellation, and cleanup

**Reader order**, with error codes:

1. `NOT_AJB1`.
2. `TRUNCATED` (short header).
3. `LIMIT_EXCEEDED` (file size).
4. `UNSUPPORTED_VERSION`.
5. `MALFORMED_HEADER`: length, reserved bytes, AEAD, secret kind, `L`, or
   domain version 0.
6. `UNSUPPORTED_SCHEMA`.
7. `UNSUPPORTED_KDF`.
8. `KDF_PARAMS_REJECTED`.
9. `TRUNCATED` (layout).
10. `INSUFFICIENT_STORAGE` (restore only).
11. `SECRET_KIND_MISMATCH`.

Only after all of these does the KDF run. Then `AUTH_FAILED` (unwrap or
any segment), then the section, manifest, record, and digest codes of
§9.4–9.6.

**Export:**

1. Take one read snapshot. In pass 1, compute the canonical records'
   length, SHA-256, and counts, and every recording's PCM size and
   digest. Ready recordings take the digest from the database;
   recoverable ones are decrypted and hashed chunk by chunk.
2. Check limits and free space.
3. Run the KDF and wrap the DEK.
4. In pass 2, stream the sections through the segment sealer into
   `cache/ajb1-<128-bit random>.part`, which is app-private and excluded
   from OS backup.
5. Reopen and verify the temporary file completely.
6. Copy it to the user-chosen document, then reopen and verify the
   destination before reporting success.

Plaintext exists only in bounded memory buffers: at most one segment and
one record line, plus an AJR1 chunk.

**Restore:**

1. Run the pre-KDF checks, then the KDF and unwrap.
2. Stream MANIFEST and RECORDS. Each record is validated and written into
   a **staging vault**: `staging-<random>/` with a fresh in-memory master
   key, a SQLCipher database, and AJR1 recordings.
3. Run the cross-record checks.
4. Stream each RECORDING, re-encrypting it to AJR1 while hashing it.
5. Read END and confirm the final segment authenticated.
6. The user sets the new PIN, which wraps the staging master key.
7. Activate with one same-filesystem directory rename and a vault-pointer
   switch.

**Cleanup:**

- **Cancel or failure** at any step deletes the temporary or staging
  directory. Export also deletes a destination document it created, best
  effort, and says so if the provider refuses. The existing journal is
  unchanged.
- **Process death.** At the next startup every `staging-*` directory and
  `*.part` file is deleted. Their keys died with the process, so they are
  unreadable ciphertext.
- **No plaintext files, ever.** Platform tests plant canary strings and a
  known PCM pattern in a journal. After each phase, after cancellation,
  and after a kill at each phase, they scan the cache, staging, and temp
  directories, and the output, and find neither.

### 9.11 Vectors (`schemas/ajb1/v1/`)

**`vectors.json`** lists:

- **Inputs.** Every input of every vector: secrets, every "random" value
  as a SHA-256 counter stream, KDF parameters, the expected KEK, and the
  expected archive SHA-256. Another implementation must reproduce each
  valid archive **byte for byte** and read it to the expected records
  (`*.records.ndjson`) and PCM digests.
- **Valid vectors:**
  - an empty journal;
  - Unicode written entries (NFD text, ZWJ emoji, Arabic, control
    characters) with an NFD password;
  - a 3-segment voice journal, with a correction chain, live-only text,
    and a recovery key;
  - a plaintext of exactly one segment, which ends with an empty final
    segment.
- **Hostile vectors**, each with its expected `code` and `stage`:
  - byte-level recipes (truncate, xor, set, append, swap, duplicate,
    drop, or splice a segment) applied to a valid base, covering every
    header field, KDF bounds, layout, and segment attack;
  - re-sealed archives with malformed plaintext, covering manifest and
    record canonicality, duplicate keys, unknown fields and types, limits,
    digests, counts, references, and section order and framing;
  - secret and context cases: wrong password or recovery key, secret-kind
    mismatch, and insufficient storage.
- **Recovery-key and password vectors:** BIP-39 known answers, decoding
  rules, and NFC normalization.

**Regeneration.** `node tools/ajb1-reference/generate-vectors.mjs
--check` regenerates every vector and compares it byte for byte. The
vectors use the provisional KDF values above and are regenerated when
the benchmark freezes the parameters.
