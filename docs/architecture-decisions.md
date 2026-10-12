# Architecture Decisions

This file is the source of truth for Audio Journal v0.1 decisions. These are
design contracts, not implementation claims.

## ADR-001: Journal-first product

**Status:** Frozen.

**Decision:** Audio Journal is primarily a private daily journal, not an AI
assistant. Capture, reading, playback, and editing work without AI and without a
Private AI Node. AI remains optional and mostly invisible outside explicit
organization actions and developer diagnostics.

## ADR-002: Source-of-truth hierarchy and provenance

**Status:** Frozen.

**Decision:** Original audio or original written text is authoritative. A
transcript is subordinate to its source recording. Summaries, categories,
topics, tasks, people, projects, and other AI output are derived artifacts.

Derived data never overwrites source data. Each derived artifact stores the
entry ID, source transcript segment IDs, and audio time ranges where available.
Every extracted task from a voice entry must cite at least one transcript segment
and the exact audio time range where the task was formed; a task without that
reference is invalid and is not persisted. Written-entry tasks cite the relevant
text range. Users may correct transcripts or derived artifacts without mutating
the original recording. Re-running AI creates a new derivation revision or
explicitly replaces only an earlier derived revision.

## ADR-003: Diary and organized modes

**Status:** Frozen.

**Decision:** Diary mode accepts raw voice or written entries without requiring
categories, summaries, tasks, mood analysis, or AI commentary. Organized mode
is explicitly invoked by the user and creates optional views such as Work,
Personal, Ideas, Tasks, People, and Projects over the source entries.

No background process silently organizes private journal content by default.

## ADR-004: Local/private-first and no accounts

**Status:** Frozen.

**Decision:** Core journal data lives on the user's device. No account, sign-up,
sign-in, public backend, or public cloud AI service is required. The app remains
usable offline. A paired user-controlled Private AI Node may receive the minimum
content needed for an explicit capability request.

Synchronization, hosted backup, application-level public relay, and multi-user collaboration are
outside v0.1.

## ADR-005: Local app lock

**Status:** Frozen.

**Decision:** First use establishes a local PIN/passcode. Supported platform
biometrics may be enabled only as a convenience unlock backed by secure local
credential/key storage. PIN/passcode fallback remains available after biometric
failure, lockout, unavailability, disabling, or enrollment changes.

The app consumes only the platform authentication result and never reads,
stores, serializes, logs, or transmits raw biometric data or templates. There is
no email or server recovery path. Destructive local reset behavior must be clear
before implementation.

## ADR-006: React Native, native-capable runtime, and state boundaries

**Status:** Frozen foundation; individual library versions remain Open.

**Decision:** Use React Native with TypeScript and the New Architecture. The app
must support custom native modules and the Hybrid AI TurboModule/JSI package; it
does not target Expo Go. React Navigation is the target navigation layer.
Zustand may hold transient UI/session/recorder/playback/AI state, but durable
journal data never uses an in-memory state store as its database.

## ADR-007: Structured data and recording storage

**Status:** Target; encryption mechanics Open.

**Decision:** Store relational domain data in SQLite behind repository
interfaces. Store recordings as files in the app-private filesystem and keep
only metadata/path references in SQLite. Do not store large audio blobs in the
database. Enable SQLite WAL unless encryption-library constraints require a
documented alternative.

**Open:** SQLCipher or another database-encryption mechanism; recording-file
encryption format and streaming strategy; key hierarchy; and local persistence
migrations. Portable backup behavior is governed by ADR-013, whose binary
cryptographic/container format remains Open. Resolve before persistence implementation.

## ADR-008: Native-owned recording abstraction

**Status:** Frozen boundary; concrete library Open.

**Decision:** The application owns a `RecordingService` TypeScript interface
implemented by native-capable Android/iOS audio code or a replaceable library.
It must support continuous capture, pause/resume, durable writes, sample levels,
audio frames for live STT, interruptions, and crash-safe finalization.

Persisting the recording is independent from transcription. STT or SDK failure
must never stop, discard, or corrupt source audio.

## ADR-009: Live transcription

**Status:** Frozen UX. The current engine boundary is decided by ADR-021;
ADR-016 is the historical pre-RI implementation.

**Decision:** Timestamped transcript segments appear while the user speaks.
Provisional text may be revised until a segment is finalized. Recording remains
the source of truth. If live STT is unavailable, recording continues and the app
offers retry/transcribe-later behavior.

**Historical pre-RI note:** audio-frame chunking and post-recording
reconciliation were originally assigned to the app-owned ADR-016 engine.
ADR-021 now governs: AJ supplies a bounded decrypted PCM/source reader backed
by encrypted AJR1 storage to SDK-owned local `audio.transcribe@1`; it transfers
no recording key or file path to the SDK and never sends audio to the node.

## ADR-010: Hybrid AI public boundary

**Status:** Frozen.

**Decision:** Consume a versioned packaged Hybrid AI SDK artifact only through
public TypeScript/TurboModule APIs. Do not copy SDK source or import private
headers. The SDK owns capability execution, validation, admission, streaming,
and Private AI Node connectivity. Under ADR-021 the app/user supplies explicit
`local` or `node`; SDK target selection applies only to future `auto`. This app
owns capture, persistence, UI, journal and task domains, provenance, lock
state, and user-visible recovery.

`journal.organize@1` and other journal-specific contracts are owned by this app
and its Private AI Node integration, not by SDK core.

## ADR-011: Explicit node-assisted organization

**Status:** Frozen.

**Decision:** Node-assisted organization occurs only after a user action that
clearly identifies the entry or range being processed. The app sends the minimum
required source, normally transcript text plus provenance identifiers rather
than original audio. The user can cancel; source content stays intact on error.

There is no fallback to a public cloud endpoint.

## ADR-012: Documentation and delivery discipline

**Status:** Frozen.

**Decision:** Requirements, architecture, detailed design, UX, security,
diagrams, capability schemas, tests, and implementation evolve together.
Implementation starts in roadmap order, with Android-first progression matching
the SDK schedule and mandatory iOS catch-up before v0.1 release claims.

## ADR-013: Portable local backup and restore

**Status:** Frozen product boundary; archive cryptography/format Open.

**Decision:** v0.1 provides a user-initiated encrypted full-journal backup that
can restore the journal after app data is cleared or the app is reinstalled.
The user chooses the destination with the platform document picker. The app has
no backup account or hosted storage and does not upload automatically.

The backup contains source entries/audio, transcripts, derived Work/Personal and
other organized views, tasks, and their exact provenance. It excludes the local
PIN verifier, biometrics, device-bound Keychain/Keystore keys, logs, and Hybrid AI
node pairing credentials. Restore creates new local lock state and requires node
re-pairing.

The portable archive uses a strong backup password or generated recovery key;
the short app-lock PIN alone is not an acceptable offline archive secret. v0.1
restore targets an empty journal and activates only after complete authenticated
validation. The logical contract and UX are in `backup-and-restore.md`; exact
container, AEAD, KDF, chunking, and version fixtures require an accepted ADR
amendment before implementation.

## ADR-014: AJ-0 scaffold and replaceable lock adapters

**Status:** Frozen for the AJ-0 foundation; production security mechanisms Open.

**Decision:** Scaffold with React 19.2.3, React Native 0.87.0 New Architecture,
React Navigation 7, TypeScript, Jest 29, and React Native Testing Library 14.
Android keeps min API 26 and target API 35; compile API 36 is required by React
Native 0.87's AndroidX dependencies and does not change runtime support.

Implement the lock/navigation/privacy shell behind `LockCredentialStore` and
`BiometricAuthenticator` ports. AJ-0 may use an explicitly named volatile
process-memory verifier for UI/state testing only. It may not persist a PIN,
claim cryptographic protection, enable production biometric unlock, or settle
KDF/backoff/reset semantics before the security ADR. Android applies
`FLAG_SECURE`, and the cross-platform JS shell obscures background snapshots.

Consume Hybrid AI only through `@hybrid-ai/react-native`'s public root API. The
development workspace may use a local package link pinned by its declared
version; this is not a releasable artifact. A publishable package with a valid
Metro entry point is required before AJ-0 acceptance. (Superseded for the
package source by ADR-015: the app now consumes the packed M5 tarball and AAR.)

## ADR-015: AJ-3 Private AI Node integration through the packaged SDK

**Status:** Frozen for AJ-3 (Android-first). Supersedes ADR-014's development
package link.

**Decision:**

- **Pinned artifacts.** The app depends on the packed
  `hybrid-ai-react-native-0.1.0-m5.tgz`. It was built from SDK M5.5 `e0fc3c5`
  (G5-A `07a8bf7`) until the 2026-10-12 amendment below moved the pin to the
  accepted SDK-AJ-5 packages from `c4b302e`. The package's `:hybrid-ai-android` Gradle project is satisfied
  by `android/hybrid-ai-android`, a wrapper over the packaged release AAR from
  the same commit. The build fails if the AAR's SHA-256 differs from
  `hybridAi.aarSha256`. Neither file is copied into this repository, and no
  path into the SDK working tree is used. Packaged ABIs are restricted to the
  SDK's `arm64-v8a` and `x86_64`. Release builds are R8-minified, relying on
  the AAR's consumer rules.
- **One adapter.** Only `src/platform/hybrid-ai/PackagedHybridAiGateway.ts`
  imports `@hybrid-ai/react-native`, and only its public root. It maps SDK
  values and typed errors into the app-owned `HybridAiGateway` port. SDK error
  messages are dropped; codes and structured reasons are kept.
- **Start after unlock.** The SDK is created on first unlock (AJ-FR-035) with
  `pairing: true` and the app routing policy. The policy only restricts
  routing (`allowLocal`, `allowNode`) and is not persisted until the
  persistence ADR exists.
- **Lock ends attended flows.** Locking stops discovery, cancels an
  unfinished pairing ceremony, drops any entered pairing code, and cancels an
  in-flight diagnostic request. Trust and the node connection are left to the
  SDK. Unlocking refreshes status and reconnects an active paired node.
- **Pairing input.** The user pastes or enters the QR payload text and checks
  it before a ceremony starts. Camera scanning is deferred: it needs a camera
  library and permission decision. The code is cleared from input and memory
  once used, and a code already past `expiresAt` on the device clock is
  refused locally. The SDK and node still enforce expiry and replay.
- **Untrusted discovery.** Discovery results are shown as unverified hints
  and never as paired. A candidate is flagged as possible impersonation when
  it claims a paired node ID, when several announcements share one ID, or
  when it reuses a node name with a different ID. Node names are shown
  stripped of control and bidi-override characters and inside a
  first-strong isolate.
- **Packaged local models.** The SDK's local models are application-provided
  (SDK ADR-019). At launch the app copies the AAR's verified model assets into
  no-backup storage and passes that directory to `createHybridAI`. If the SDK
  rejects the directory, the app restarts the SDK without local models so
  that node features keep working.
- **Diagnostics.** Developer diagnostics show only codes, targets, routing
  reasons, request IDs, counts, capability descriptors, and durations. Input
  and output text are never displayed or logged. AJ-3 exercises the
  product-neutral `document.analyze@1` because `journal.organize@1` is still
  Open (ADR-010, Open decision 4).
- **Device E2E harness.** Android device tests use a dependency-free Node.js
  driver over `adb` and `uiautomator` (`e2e/android/`), with React Native
  `testID`s as selectors. Evidence is UI-hierarchy text, because `FLAG_SECURE`
  intentionally blocks screenshots. A standalone fixture APK advertises test
  services through Android's public `NsdManager` for discovery and spoofing
  scenarios. No SDK code is imported.

**Amendment (2026-10-12): SDK-AJ-5 package pin.** The pinned artifacts move
to the packages built from SDK commit `c4b302e`, in
`../hybrid-ai-packages/c4b302e/`:

| Package | SHA-256 |
|---|---|
| RN tarball | `a11cba67036d6e38662e6485c75d891dfc0110ebc41cd05aa7ea8f870c14ee2a` |
| AAR | `8751a5a7623a2c6ea5a75216afd410d9483410da3c9f96f4c4527c852da86b1a` |

- **Source.** `c4b302e` is on the SDK branch `fix/sdk-aj-5-node-cancel`: the
  fix for SDK-AJ-5, a cancellation that never reached the node. The version
  string stays `0.1.0-m5`, and the public API is unchanged.
- **What changed in the packages:**
  - In the AAR, only `libhybrid_ai_core.so` differs, for both ABIs. The
    other 17 of 19 files, including the model assets and manifests, are
    byte-identical to `e0fc3c5`.
  - In the tarball, the runtime sources are identical. It only drops stray
    Gradle cache files and updates an instrumented test.
- **SDK acceptance.** The SDK owner accepted the fix and merged it into SDK
  `main`: merge commit `855edaf`, SDK `main` at `59b2cd8`. The accepted
  package source is `c4b302e`, with the hashes above. The merge did not
  change the packages, so the pin and the evidence stand.
- **History.** Evidence recorded earlier against `e0fc3c5` stays attributed
  to that package.

## ADR-016: Application-owned transcription; SDK receives text

**Status:** Superseded for target design by ADR-021 (owner decision,
2026-10-12). The text below records the implemented pre-RI architecture and its
historical evidence; it is not the architecture to extend. It previously superseded the earlier
assumption (ADR-009, AJ-1, HLD flow 4) that Audio Journal transcribes through
a Hybrid AI SDK capability.

**Decision:** Transcription is application-owned preprocessing. The Hybrid AI
SDK receives text through generic capability contracts and stays independent
of recording and speech-engine implementation.

```text
Audio Journal
  ├── records and stores audio
  ├── runs its chosen transcription engine (TranscriptionService)
  └── sends transcript text, or explicitly selected sections
          ↓
Hybrid AI SDK
  └── local/node/auto AI capabilities for analysis and organization
```

- Audio Journal owns recording, codecs, transcription, timestamps, correction,
  and transcript persistence.
- Transcription sits behind the app port `TranscriptionService`. The
  implementation is on-device and private: audio never leaves the device for
  transcription.
- The Android engine is whisper.cpp v1.9.5 (commit `d1be6fde`), built from a
  SHA-256-pinned source archive into the app's own native library.
- The default model is `base.en-q5_1` (SHA-256 `4baf70dd…dd2f`).
  `tiny.en-q5_1` (`c77c5766…7c2b`) is an explicit low-resource option. There
  is no automatic model switching. Models are app assets, pinned by SHA-256
  and verified before load.
- The Hybrid AI SDK gains no Whisper-specific API, model, or packaging. The
  accepted G5-A package (`e0fc3c5`) is unchanged. A generic multimodal
  provider-extension mechanism in the SDK would be a separately designed SDK
  milestone.

**Consequences:** AJ-1 no longer waits for an SDK transcription capability.
The SDK roadmap's AJ-1 wording ("local transcription capability through the
SDK") is superseded for this application; that change is recorded here, not
in the SDK repository. Speech accuracy is the app's responsibility and is
evaluated with the real-speech suite (`e2e/speech`).

## ADR-017: Encrypted vault, persistent PIN, biometrics, recording, and AJB1 backup (AJ-1)

**Status:** Frozen (owner decisions, 2026-10-09). It resolves the parts of
ADR-005, ADR-007, ADR-008, ADR-009, and ADR-013 that block AJ-1.

Two items stay open until measurements exist:

- the Argon2id cost parameters, which are frozen only after a benchmark on
  the lowest-supported Android device (see the **Argon2id** section);
- the live-transcription window length and overlap.

Implementation of AJB1 waits until its binary format and its hostile and
cross-platform vectors are frozen in `backup-and-restore.md`.

### Key hierarchy

- **Master key.** A random 256-bit vault master key (MK) is created at PIN
  setup. It lives in native memory only while the journal is unlocked, is
  zeroed on lock, and is never exposed to JavaScript.
- **PIN copy.** The PIN key-encryption key is Argon2id(PIN, 16-byte salt) with
  the device-benchmarked parameters below. PBKDF2-HMAC-SHA256 is allowed only
  as a documented portability/FIPS fallback, recorded by algorithm ID. The
  PIN-wrapped copy is `KeystoreAES-GCM(AES-GCM(PIN KEK, MK))`. The outer
  non-exportable Keystore AES-256-GCM key binds the copy to this device. A
  wrong PIN fails the inner GCM tag, so no PIN verifier is stored. Neither the
  PIN nor any derived key is persisted.
- **Biometric copy.** A second, independently usable copy of MK is wrapped by
  a separate Keystore AES-256-GCM key. That key is created with
  `setUserAuthenticationRequired(true)` and
  `setInvalidatedByBiometricEnrollment(true)`, and allows only
  `BIOMETRIC_STRONG`. It is used only through a cryptographic `BiometricPrompt`
  (`CryptoObject`) operation. Biometrics are a convenience path; the PIN copy
  always remains. If enrollment changes, the key and its copy become unusable:
  the app deletes them, the user unlocks with the PIN, and biometric unlock
  stays off until the user explicitly re-enables it (which creates a new key
  and copy). The app receives only the platform result; no biometric data is
  read, stored, or logged.
- **Attempt policy.** After 5 consecutive PIN failures, unlocking is refused
  for 30 s, doubling per further failure up to 1 h. The counter is kept in the
  Keystore-sealed vault file.
- **Purpose keys.** The database and recording keys are derived with
  HKDF-SHA256 from MK, using the labels `aj-db-v1` and `aj-rec-v1`.
- **Changing the PIN** rewraps the PIN copy atomically (write a temporary
  file, fsync, rename). No data is re-encrypted, and the biometric copy is
  unaffected.
- **Forgotten PIN.** There is no recovery. The only path is **Erase
  journal**, which needs explicit typed confirmation and deletes the vault
  file, database, recordings, and both Keystore keys. Block-level erasure is
  not claimed.

### Argon2id (PIN copy and AJB1 KEK)

- **Implementation.** The P-H-C reference libargon2, release `20190702`
  (commit `62358ba2`, archive SHA-256
  `daf972a89577f8772602bf2eb38b6a3dd3d922bf5724d45e7f9589b5e830442c`,
  CC0/Apache-2.0),
  compiled into the app's native library. Algorithm Argon2id, version `0x13`.
  One C implementation serves Android now and iOS later, so backups are
  byte-identical across platforms.
- **Parameters.** Memory `m` (KiB), time `t`, and parallelism `p` are chosen
  by a benchmark on the lowest-supported Android device; the emulator alone is
  not enough. They are stored with the algorithm ID, version, and salt in an
  authenticated record: the vault file, or the AJB1 header.
- **Rejection.** Readers reject unknown versions, downgrades below the
  accepted floor, malformed parameters, and memory or time beyond accepted
  ceilings before allocating anything.
- **Handling.** Password-derived buffers are cleared after use and never
  cross into JavaScript.
- **Tests.** Allocation failure and low-memory behaviour are tested, and
  Android output is cross-checked against independent host vectors (iOS
  later).

### Storage

- **Database.** SQLite through SQLCipher for Android
  (`net.zetetic:sqlcipher-android:4.19.1`), keyed with the raw HKDF database
  key, in WAL mode, in app-private no-backup storage.
- **Recordings.** Recordings are 16 kHz mono 16-bit PCM in the `AJR1`
  container: an authenticated header followed by sealed PCM chunks of up to
  1 second. Recordings never exist as plaintext files. The owner amended the
  key and nonce design on 2026-10-10 (formerly Open decision 7):
  - **Per-recording key:** `K_file = HKDF-SHA256(recordingRootKey,
    fileSalt, encodedInfo, 32)`.
    - `recordingRootKey` is `HKDF(MK, "aj-rec-v1")`.
    - `fileSalt` is 16 fresh CSPRNG bytes, stored in the header.
    - `encodedInfo` is the length-prefixed label
      `audio-journal/ajr1/recording-key/v1` followed by the length-prefixed
      ASCII recording ID.

    A new file, or a recreated one, always gets a new salt and therefore a
    new key. Derived keys are cleared when the recording closes or the vault
    locks.
  - **Nonce:** a 4-byte per-file prefix plus the unsigned 64-bit chunk
    index. Nonces are unique because each file has its own key.
  - **Authentication:** every frame carries its chunk index. The AAD binds
    the header hash, the recording ID, and that index. A wrong key, salt,
    header, recording ID, or index fails authentication.
  - **Ordering:** indices strictly increase. Gaps are allowed; duplicates,
    decreases, and reordering are rejected. An index above `2^48 − 1` is
    rejected, and the writer refuses to overflow.
  - **Crash recovery** keeps every authenticated frame and drops the torn
    tail. If torn bytes exist, any index they may have used is never reused
    under the same key: writing continues at least two past the last
    authenticated index, and past any readable torn index.

  The byte layout and vectors are in LLD §5.1 and `schemas/ajr1/v1/`.

### Recording (closes ADR-008 for Android)

- A native `AudioRecord` writer with pause, resume, and finish.
- Loss of audio focus (for example, a call) auto-pauses.
- Leaving the foreground auto-pauses and seals the current chunk; a
  foreground service is deferred.
- Recordings are limited to 60 minutes. Recording won't start with less
  than 200 MiB free and finishes automatically below 50 MiB (binary units,
  2^20 bytes; owner clarification, 2026-10-10).
- Unfinished recordings are reconciled at startup. Interrupted captures
  are kept as ready recordings (see **Owner decisions of 2026-10-10**).
- Recording never depends on transcription: it continues whenever
  transcription is unavailable, slow, cancelled, or failing.

### Transcription in AJ-1 (ADR-016 engine)

- **Engine.** Transcription runs on-device (ADR-016) on decrypted PCM in
  native memory; audio never reaches JavaScript or Hybrid AI.
- **Live text (frozen UX).** Provisional text appears while recording. It is
  produced from bounded, overlapping windows of recent PCM, with provisional
  segment revisions, cancellation, de-duplication across window overlaps,
  and final reconciliation. The window length, overlap, and cadence are not
  frozen; they are set from device measurements and recorded in validation
  evidence before any performance claim.
- **Final pass.** After Finish, a full pass over the sealed recording
  produces transcript revision 1 (source `engine`, with the model ID). It
  supersedes the provisional text.
- **Corrections.** A user correction creates a new segment revision with
  source `user`. The engine segment and the recording are never changed.

### Portable backup `AJB1` (closes ADR-013's cryptography)

- **Envelope encryption.** A random 256-bit archive data-encryption key
  (DEK) encrypts bounded chunks with AES-256-GCM, each with a unique nonce.
  An Argon2id key-encryption key (KEK), derived from the user's secret,
  wraps the DEK. The password-derived output never encrypts chunks directly.
- **Secret.** Either a strong user password, rejected below a documented
  strength floor, or a generated recovery key carrying at least 128 bits of
  randomness. It is never the app PIN.
- **Authentication.** The header (magic, version, KDF algorithm, version,
  `m/t/p`, salt, wrapped DEK), every chunk's position and ordering, the
  manifest, and an explicit final chunk are all authenticated. Truncation,
  reordering, splicing, and parameter tampering are therefore detected.
- **Contents.** Entries, transcripts and revisions, derivations, tasks,
  provenance, and recording PCM. It excludes the PIN, MK, Keystore keys,
  biometric state, node pairing, logs, and caches.
- **Saving.** The archive is saved through the system document picker,
  then reopened and fully authenticated before success is reported.
- **Restore.** Restore only targets an empty journal (as defined below). It
  works in isolated staging and activates atomically after complete
  verification. The user re-enters the current PIN, which then protects the
  restored vault (owner decision, 2026-10-10). The node must be re-paired.
- **Format first.** The binary layout and its hostile vectors (tampering,
  truncation, downgrade, excessive memory, malformed fields) and
  cross-platform vectors are frozen in `backup-and-restore.md` before any
  implementation.

### Owner decisions of 2026-10-10 (afternoon)

These amend the sections above. Each is reflected in `backup-and-restore.md`,
`ux-design.md`, and the LLD, and has tests.

1. **System UI the app opens itself (lock grace).**
   - The app's own microphone permission dialog and system document picker
     pause the activity.
   - While one of those is open, relocking is deferred for at most
     2 minutes. After that, the app locks anyway.
   - The privacy curtain and `FLAG_SECURE` stay on throughout.
   - Any other backgrounding (Home, app switch, screen off) still locks
     immediately.
2. **Interrupted captures are kept.** A capture that ended without Finish
   (lock, process death) is handled at the next unlock as follows:
   - Reconciliation drops a torn final frame.
   - It then promotes every authenticated chunk to a ready recording, with
     finish reason `recovered`.
   - Only real damage keeps a recording in "needs attention" (recoverable):
     an authentication or ordering failure before the end of the file. The
     bytes after the damage are kept.
3. **Final passes restart after unlock.** This is the explicit policy LLD §9
   step 5 asks for:
   - Ready recordings without a full pass are queued after unlock, one at a
     time.
   - Passes run on-device only, are cancellable, and never block capture.
   - A pass that fails in a session is retried only when the user asks.
4. **Damaged recording during backup.**
   - By default, the backup stops safely and lists every affected entry
     (date, title, and damaged component).
   - Continuing without those entries needs explicit confirmation. Content is
     never excluded silently.
   - The result reports the exclusion, and the journal is unchanged.
   - **Where incompleteness is recorded** (`AJ1-DEC-001`, option B, confirmed
     by the owner): AJB1 v1 stays byte-frozen, with no manifest field. The
     result screen shows counts and non-sensitive entry labels, the suggested
     file name ends in `-incomplete`, and local backup history keeps a
     counts-only incomplete status.
   - **Known limitation.** A file that is renamed or moved without its local
     history cannot prove that damaged entries were omitted.
   - A self-describing incomplete archive is recorded for a future container
     (AJB2).
5. **Restore activation needs the current PIN.**
   - Being unlocked is not enough: the current PIN is re-entered under the
     normal attempt policy.
   - That PIN wraps the restored vault's new master key.
   - The biometric copy is removed; the user can re-enable it later.
   - The app locks immediately, and a normal unlock opens the restored
     journal.
   - Someone holding an unlocked phone cannot replace the journal without the
     PIN.
6. **"Empty journal" for restore.** The journal is empty when it has no
   ready entries, no needs-attention entries, and no playable recording file.
   - Tombstones, abandoned drafts, and failed recording artifacts do not block
     restore.
   - They are counted on the confirmation screen and need explicit
     confirmation.
   - They are discarded together with the old journal (rows and files) when
     activation completes.
   - If activation fails, the pre-restore vault is unchanged.
   - Any visible journal content blocks restore.
7. **Recovery-key confirmation.**
   - The phrase is hidden first.
   - The user then types the words at three distinct positions, chosen with
     the platform CSPRNG, and they are checked exactly and in order.
   - On failure the user returns to the phrase and may try again.
   - Answers are never logged or stored, and a checkbox alone never counts as
     confirmation.
   - `FLAG_SECURE` and the privacy curtain stay on throughout.

## ADR-018: `journal.organize@1` served by an Audio Journal node companion

**Status:** Contract ownership remains frozen; engine/deployment ownership is
superseded by ADR-021 (owner decision, 2026-10-12). The standalone companion
and deterministic engine below describe the implemented pre-RI baseline, not
the target to extend. It previously resolved Open decision 4
for v0.1 and keeps ADR-010/011 intact.

**Decision:**

- **Contract.** `journal.organize@1` is owned by Audio Journal. Its
  request, result, and event JSON Schemas and its provenance rules are frozen
  in this repository (`schemas/journal/v1/`), with test vectors.
- **Companion.** The capability runs on the **Audio Journal Private Node
  companion** (`node-companion/`), a separate process in this repository.
  It is neither part of the Hybrid AI SDK nor its reference node. To be
  reachable through the SDK it is a Private AI Node in its own right: an
  independent implementation of the SDK's published node protocol (ADR-021
  jobs/streaming, ADR-022 pairing/mutual TLS). It is checked against the
  SDK's published vectors and against the packaged SDK on device. No SDK
  source is copied or imported.
- **What "separate" means** (owner clarification, 2026-10-10). The companion
  is a separately built and deployed process, kept as a subproject of this
  repository (`node-companion/`). It is not a separate Git repository: Audio
  Journal owns `journal.organize@1`, so its server lives here.
  - It is not bundled into the Android or iOS application.
  - It is not part of the Hybrid AI SDK repository or its reference node.
  - It imports no SDK-private source.
  - It communicates only through the SDK's published node protocol.
  - It uses the authoritative schemas and vectors in `schemas/journal/v1/`.
- **Client path.** The mobile app invokes the capability only through the
  SDK public API (`execution: 'node'`), after an explicit user selection,
  sending only finalized transcript or written text with segment IDs and
  offsets (ADR-011). Audio is never sent.
- **Engine.** The first engine is deterministic and explainable (phrase
  rules, lexicons, sentence segmentation). It produces a summary, Work and
  Personal sections, ideas, people, projects, and tasks. Every item cites
  exact segment IDs, character ranges, and audio ranges. A model-backed engine
  may replace it later behind the same contract and vectors.
- **No substitutes.** `document.analyze@1` is not used as a substitute, and
  the app bundles no extra inference runtime for organization.
- **Validation.** The app validates every result (schema, bounds, provenance
  inside the request scope) before persisting it as a new derivation
  revision. Invalid results are discarded with `INVALID_RESULT`.

## ADR-019: `journal.organize@1` contract frozen

**Status:** Frozen for implementation (AJ-2.0, 2026-10-11), except the
questions listed as Open in `journal-organize.md` §12.

**Context:** ADR-018 decided ownership and runtime and required the request,
result, and event schemas, provenance rules, and vectors to be frozen before
implementation. Earlier documents disagreed on execution targets, the error
code, character ranges, and which items must cite sources.

**Decision:** `docs/journal-organize.md` is the normative contract, with the
schemas and vectors in `schemas/journal/v1/`. In summary:

The following execution and companion bullets describe the historical AJ-2
baseline. ADR-021 supersedes them for the RI target: execution is explicit
`local | node`, and the generic SDK-owned Ubuntu Private AI Node replaces the
standalone companion. Schema, provenance, validation, persistence, and TLS
requirements remain authoritative.

- **Historical AJ-2 capability deployment:** `journal.organize` `1.0.0`,
  streaming, executed only on the paired node (`execution: 'node'`), with a
  60 s deadline and no fallback. Every message carrying journal content is at
  most 61,440 bytes with its envelope: inputs up to 61,108 bytes and results
  up to 61,387.
- **Input:** 1–20 whole entries. Voice entries send the current transcript
  (newest full pass, correction heads) with segment IDs and timings; written
  entries send paragraph units with their offsets. Every unit carries a
  SHA-256 of its text. Audio, paths, keys, and unrelated entries are never
  sent; IDs are the opaque local IDs.
- **Result:** summary, Work and Personal sections, tasks, ideas, people, and
  projects, as requested. Every item cites 1–8 source references with exact
  UTF-16 character ranges and, for voice, an audio range inside the cited
  segment. The result echoes `requestKey` and the input digest.
  `requestKey` is an opaque HMAC of the canonical request under an app-local
  key: reused only for an identical request, never revealing content.
- **Validation:** a fixed rule order (`journal-organize.md` §6) with
  diagnostic sub-codes; any violation discards the result as
  `INVALID_RESULT`. Partials carry counts only and are never persisted.
- **Persistence:** one transaction writes an immutable derivation revision,
  its scope, tasks, and references; `requestKey` is unique, so a delivery
  can never be stored twice. Sources are never written.
- **Historical AJ-2 companion:** an independent ADR-021/ADR-022 node in
  `node-companion/` (Node.js 22), built only from the SDK's published protocol,
  schemas, and vectors. It keeps the frozen Android support profile: TLS 1.3, and on
  API 26–28 the restricted TLS 1.2 profile (ECDHE-ECDSA AEAD suites with
  Extended Master Secret, refused without EMS). Certificates and ASN.1 come
  from a pinned, established dependency, never hand-written DER; primitives
  come from Node's OpenSSL. Job content stays in memory only, within the
  protocol's retention.

**Amendment A1 (2026-10-11, owner decision on O-7):** lossy output is
explicit.

- A result that leaves out items found by the engine, because of the
  50-item bound or the 61,387-byte output budget, carries
  `completeness: "partial"` and per-kind `omitted` counts.
- The omitted items are always the lowest-ranked of their list.
- The app stores the marker and discloses it in every view of the result.
- Validation adds `RESULT_COMPLETENESS` after `RESULT_KINDS`.
- Input over 61,108 bytes is still a typed refusal, never truncated.
- Multi-request chunk-and-merge is not part of v1 unless separately
  approved.

The amendment came before any release, so the capability version stays
`1.0.0`. The schemas, vectors, validators, companion, and UI requirements
changed together (contract §3.2, §6, §11 decision 13).

**Amendment A2 (2026-10-12, owner decision on O-1):** tasks may carry a due
date, from explicit English phrases only.

- The accepted phrases are today, tomorrow, an unqualified weekday, and an
  English named calendar date. A weekday means the first such day on or
  after the entry's local creation date. A day and month without a year
  means the first such date on or after it; an explicit year is used as
  written.
- Qualified, numeric, time, and other ambiguous phrases are rejected.
- The date is an ISO calendar date with no time or offset, and it cites its
  exact phrase.
- The app validator independently parses the cited phrase and re-derives
  the date from the entry's `createdAt` and the request's `timeZone`. A date
  it cannot reproduce rejects the result with `RESULT_DUE` (contract §3.3).

**Consequences:** the LLD `local | auto` wording, `AI_RESULT_INVALID`, and
single `segmentId` references are superseded for this capability (§11 of the
contract). Open questions O-1 to O-7 (due dates, stale-source display,
editing, retention, AJB1 v2, diagnostics on the companion, and organizing
entries above the input cap) block only the work they name. O-1 to O-3 are
resolved: O-1 by amendment A2, O-2 and O-3 by ADR-020. F5 and request-path revocation remain SDK defects
(SDK-AJ-1, SDK-AJ-2); the app keeps its compatibility workaround.

## ADR-020: Organized history, computed staleness, and task carry-over

**Status:** Accepted (owner decision on O-2 and O-3, 2026-10-12).

**Context:** derivations are immutable revisions (ADR-019, contract §7).
The Organized and Tasks views (AJ-2.2) need to answer three questions:

- which revision to show, and how the history is grouped;
- what happens when a cited source changes after organizing;
- whether a task's done or dismissed state survives a reorganize.

**Decision:**

- **Canonical selection identity.** A derivation's scope is its set of
  entry IDs: deduplicated, sorted by UTF-16 code units, and joined with
  `,` (`scope_key`). A reordered or repeated selection is the same scope,
  so history and revision numbers never split.
- **History.** Each scope shows its newest revision. Older revisions stay
  readable from history, and none is changed or deleted.
- **Staleness is computed, never stored.**
  - A voice reference is stale when its cited segment is no longer in the
    entry's current transcript. That happens after a correction (the chain
    has a newer head) or a re-transcription (a newer full pass).
  - A written reference is stale when the unit at that `unitId`, re-split
    from the entry's current text by the contract §2 rules, no longer has
    the cited digest.
  - A reference to an entry that is no longer ready is stale.
  - An item is stale when any of its references, its due-date source
    included, is stale.

  A stale item shows "Source changed since organized". Its source link still
  opens the originally cited text, labelled as edited since. Reorganize is
  offered and always asks for consent; nothing reorganizes automatically,
  and no item is hidden because it is stale.
- **Derived text is not editable in v1.** This covers summary, section,
  task, idea, person, and project text.
- **Task states.** A task is `open`, `done`, or `dismissed`, and restore
  returns it to `open`. Each change records `state_changed_at`.
- **Conservative carry-over.** When a new revision of a scope is saved,
  each of its tasks may take the state of a task in the scope's previous
  revision, but only when all of these hold:
  - the normalized task texts are equal (contract §6);
  - the tasks' first sources cite the same entry;
  - some source of each task is related, either through the same immutable
    unit (the same `unitId` and `unitSha256`) or through an explicit
    transcript correction lineage (the new segment descends from the old
    one by `supersedes_segment_id`), and the two cited character ranges
    overlap;
  - the match is one-to-one: each task of the pair has exactly one
    candidate in the other revision. Ambiguous duplicates do not carry.

  Pairs are taken in stable rank order. The new task records its
  `predecessor_task_id`. New, unmatched, and ambiguous tasks start `open`.
  Nothing carries across unrelated entries, a re-transcription (a new pass
  has no lineage), or a written-text change that cannot be proven related.
  Historical task states are never changed.

**Consequences:** migration 4 adds `due_date` and `predecessor_task_id` to
`derived_tasks`, both immutable once written. The Organized and Tasks UI
follow UX §7. The contract is unchanged by this ADR.

## Open decisions before implementation

1. Argon2id cost parameters (from a lowest-supported-device benchmark). Key
   hierarchy, biometrics, PIN change, and reset are decided by ADR-017.
2. Background recording (a foreground service). Android capture, format,
   interruptions, duration, and storage pressure are decided by ADR-017.
3. Live-transcription window length, overlap, and cadence, set from device
   measurements. The live UX is decided by ADR-017 and the current SDK-owned
   engine boundary by ADR-021.
4. `journal.organize@1`: its runtime ownership/targets are decided by ADR-021;
   its domain contract is frozen by ADR-019 (`journal-organize.md`,
   `schemas/journal/v1/`) with remaining questions in that document's §12.
5. ~~The AJB1 binary layout and vectors~~: **frozen for implementation**
   on 2026-10-10 (backup-and-restore.md §9, with its freeze evidence).
   Still open: Argon2id parameters (item 1), iOS cross-platform evidence
   (needs macOS/Xcode), and non-empty-vault merge semantics (outside v0.1).
6. Retention/deletion behavior for recordings, transcripts, derivations, and tasks.
   Until it is decided, confirmed discards are tombstoned (rows kept and marked;
   no cryptographic-erasure claim), and superseded live transcript rows are
   kept, marked superseded, excluded from normal reads, and bounded to 4,000
   per recording (owner decisions, 2026-10-10).
7. ~~AJR1 nonce uniqueness across files~~. **Decided** 2026-10-10 by the
   owner: per-recording HKDF keys, chunk-index frames, and torn-tail index
   skipping. See ADR-017's **Recordings** bullet.

## ADR-021: SDK-owned AI execution and real local/node prototype

**Status:** Accepted by the owner on 2026-10-12. This decision supersedes
ADR-016 and the engine/deployment portions of ADR-018. ADR-019/020 remain
authoritative for the journal business contract, provenance, history, due-date,
and task semantics. The resumable AJ handoff is
[`real-inference-migration.md`](real-inference-migration.md), controlled by SDK
ADR-024 and its RI-0–RI-6 roadmap.

**Decision:**

1. Audio Journal owns recording, encrypted source storage, transcript and
   derivation persistence, consent, UI, `journal.organize@1` schemas/prompts,
   provenance rules, and labelled evaluation data. It owns no AI runtime.
2. All transcription and organization computation runs through packaged public
   Hybrid AI SDK capabilities. Direct whisper.cpp, llama.cpp, ONNX, Ollama, or
   model-server integration in the app is forbidden.
3. `audio.transcribe@1` is SDK-owned and explicit `local` only. Raw audio,
   recording paths, recording keys, vault material, and unrelated entries are
   never sent to a node.
4. `journal.organize@1` is application-owned as a declarative contract and may
   execute through explicit `local` or explicit `node`. The app presents that
   choice and never silently falls back or changes models.
5. The SDK repository supplies the generic Private AI Node transport, security,
   queue, and model host. `node-companion` is retired as an independent host;
   AJ schemas, prompts, vectors, and evaluation data remain here and are
   deployed as capability data/configuration.
6. `aj.rules` remains a deterministic contract oracle for isolated tests only.
   It is removed from production execution and cannot satisfy AI functional,
   accuracy, load, or performance acceptance.
7. Functional and performance evidence uses real 30-, 60-, and 180-second
   voice recordings. Longer journal recordings and extended soaks are future
   work. Evidence records exact SDK/model/provider hashes and separate local
   versus node results.
8. Existing AJ-1–AJ-4-P reports remain valid for what they measured. They are
   not real-model organization acceptance and do not close the RI gates.
9. `auto`, iOS, physical-device production budgets, arbitrary model choice,
   raw-audio node processing, and knowledge graphs are deferred.
10. Before the prototype gate closes, Android-to-Ubuntu Private AI Node use is
    validated through independently installed Tailscale clients. Audio Journal
    supplies the SDK a configured MagicDNS name or Tailscale IP plus port; it
    does not embed a Tailscale SDK or call its control plane. Both an observed
    direct path and an observed relayed path are exercised. Tailnet membership
    does not replace Hybrid AI pairing, mTLS, node-key pins, consent, or result
    validation, and mDNS is not required across the tailnet.
11. **Future, not AJ-RI scope:** a node capability may eventually ask the app
    for additional typed journal context or a device capability during a job.
    AJ remains the data authority and may deny every request. Each item must be
    allowlisted, schema/size/round bounded, explicitly related to the selected
    source scope, consent/policy checked, and persisted with provenance. The
    node receives no general journal query, database/filesystem access, audio,
    recording key, vault key, microphone activation, or arbitrary app action.
    This requires a separately accepted SDK protocol/ADR and AJ UX/security
    decision before implementation.
12. Private-node models are evaluated as resource-bounded models on the actual
    node hardware. AJ makes no assumption that their reasoning or accuracy
    matches Claude, Codex, or another hosted frontier service. Additional
    context may improve grounding but does not waive the accuracy gates.

**Consequences:** the direct app speech engine and its native build integration
must migrate behind SDK `audio.transcribe@1`. The current organization UI,
schemas, provenance validation, storage, history, tasks, pairing UX, and source
navigation are retained and exercised against real SDK results. Passing
`GRI-6-A` includes the narrowly scoped physical-phone Tailscale connectivity
proof and authorizes broader exploratory Android phone use; it does not imply
physical-device certification, canonical AJ-4, or release acceptance.
