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

Synchronization, hosted backup, public relay, and multi-user collaboration are
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

**Status:** Frozen UX; capability contract Open.

**Decision:** Timestamped transcript segments appear while the user speaks.
Provisional text may be revised until a segment is finalized. Recording remains
the source of truth. If live STT is unavailable, recording continues and the app
offers retry/transcribe-later behavior.

**Open:** exact Hybrid AI capability ID/schema, audio-frame transport, chunking,
model/language selection, and post-recording reconciliation.

## ADR-010: Hybrid AI public boundary

**Status:** Frozen.

**Decision:** Consume a versioned packaged Hybrid AI SDK artifact only through
public TypeScript/TurboModule APIs. Do not copy SDK source or import private
headers. The SDK owns capability execution, target selection, streaming, and
Private AI Node connectivity. This app owns capture, persistence, UI, journal
and task domains, provenance, lock state, and user-visible recovery.

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
Metro entry point is required before AJ-0 acceptance.

## Open decisions before implementation

1. Database and recording encryption, key hierarchy, KDF parameters, biometric
   key binding, PIN change, and destructive reset behavior.
2. Audio capture library/native implementation, file format, interruption policy,
   maximum duration, and storage-pressure behavior.
3. Live transcription capability ID/schema and audio-frame delivery contract.
4. `journal.organize@1` request/result/event schemas and provenance granularity.
5. Portable backup AEAD/KDF/container/chunking, recovery-key encoding, versioned
   cross-platform fixtures, and non-empty-vault merge semantics.
6. Retention/deletion behavior for recordings, transcripts, derivations, and tasks.
