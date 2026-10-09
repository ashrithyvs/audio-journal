# Low-Level Design

**Status:** Target contract. Open decisions are not implementation authorization.

## 1. Layer boundaries

```text
Screens/components
    -> feature controllers/view models
        -> domain services and repository interfaces
            -> SQLite/file/security adapters
        -> HybridAIAdapter
            -> packaged Hybrid AI public API
        -> RecordingService
            -> platform audio implementation
```

Dependencies point inward toward domain types. Platform and SDK-specific errors
are mapped before reaching screens.

## 2. Core domain records

### `JournalEntry`

- `id`, `kind: voice | written`, `createdAt`, `updatedAt`
- `sourceText` for written entries only
- `recordingId` for voice entries
- `title` (user or derived, with provenance/type)
- `status: draft | ready | recovery_required | deleted`

### `Recording`

- `id`, `entryId`, app-private `relativePath`
- `state: preparing | recording | paused | finalizing | ready | recoverable | failed`
- `startedAt`, `endedAt`, `durationMs`, format metadata, byte count
- content digest after finalization where streaming cost is acceptable

### `TranscriptSegment`

- `id`, `entryId`, `recordingId`, `ordinal`
- `startMs`, `endMs`, `text`
- `state: provisional | final | corrected`
- `engineRevision`, `createdAt`, `supersedesSegmentId?`

Provisional segments may be replaced by stable ID. Corrected segments preserve
the prior text/revision rather than rewriting audit history invisibly.

### `DerivedArtifact`

- `id`, `kind`, `schemaVersion`, `revision`, `status`
- `scopeEntryIds`, validated JSON payload
- `createdAt`, `capabilityId/version`, execution target
- no raw prompt, model name, or node-agent identity requirement

### `Task`

- `id`, `artifactId`, `text`, `state: open | done | dismissed`
- optional due date/project/priority only when present in validated output
- user edits and completion state are application data, not source transcript edits

### `SourceReference`

- `id`, `artifactId` or `taskId`
- `entryId`, optional `segmentId`
- optional `audioStartMs`, `audioEndMs`
- excerpt stored only when needed; source IDs/time range are authoritative

For a task derived from a voice entry, `segmentId`, `audioStartMs`, and
`audioEndMs` are mandatory. The bounds must resolve inside the finalized
recording and overlap the cited segment. The task detail/source sheet seeks the
audio player to `audioStartMs`, stops or loops at `audioEndMs`, and highlights
the corresponding transcript text. A task without a valid reference is rejected
before persistence rather than shown as an unattributed AI suggestion.

## 3. Initial relational schema

```text
journal_entries 1---0..1 recordings
journal_entries 1---* transcript_segments
derived_artifacts *---* journal_entries (artifact_entries)
derived_artifacts 1---* tasks
derived_artifacts/tasks 1---* source_references
app_settings
schema_migrations
```

Rules:

- Foreign keys enabled; migrations and multi-record updates are transactional.
- Paths are relative identifiers inside an app-owned recording root.
- No recording audio blob is stored in SQLite.
- Derived payloads are schema-versioned and bounded before persistence.
- Hard deletion is staged so database and file operations can reconcile after crash.

## 4. Repository interfaces

```ts
interface JournalRepository {
  createVoiceDraft(input: VoiceDraftInput): Promise<JournalEntry>;
  createWritten(input: WrittenEntryInput): Promise<JournalEntry>;
  finalizeVoice(input: FinalizeVoiceInput): Promise<void>;
  getEntry(id: string): Promise<JournalEntryDetail | null>;
  listEntries(query: EntryQuery): Promise<JournalEntrySummary[]>;
}

interface TranscriptRepository {
  upsertProvisional(segment: TranscriptSegment): Promise<void>;
  finalize(segment: TranscriptSegment): Promise<void>;
  correct(segmentId: string, text: string): Promise<TranscriptSegment>;
}

interface DerivationRepository {
  saveValidatedRevision(result: ValidatedDerivation): Promise<void>;
  sourceContext(ref: SourceReference): Promise<SourceContext>;
}
```

Repository calls accept domain data, not UI or SDK event objects.

## 5. Recording service

```ts
interface RecordingService {
  prepare(targetId: string, options: RecordingOptions): Promise<PreparedRecording>;
  start(prepared: PreparedRecording): AsyncIterable<RecordingEvent>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  finish(): Promise<FinalizedRecording>;
  abort(): Promise<RecoverableRecording | null>;
}
```

Events include bounded meter samples, timestamped audio frames, interruptions,
storage warnings, and terminal finalization. Raw frames use bounded native/native-
SDK paths where possible; they are not accumulated in JavaScript memory.

State transitions:

```text
IDLE -> PREPARING -> RECORDING <-> PAUSED -> FINALIZING -> READY
                       |               |          |
                       +----------> RECOVERABLE <-+
                                      |
                                   FAILED
```

Exactly one terminal recording outcome is exposed. STT has a separate operation
and cancellation token; cancelling it does not cancel recording.

## 6. Transcript stream handling

- Key updates by `(recordingId, segmentId)` and require monotonically increasing
  segment revisions.
- Enforce non-negative time ranges within current/final duration.
- Render provisional text immediately; batch persistence to avoid one DB write
  per token while maintaining bounded loss on process death.
- A final segment replaces only its provisional version.
- Late events after transcript cancellation or terminal state are ignored.
- Post-recording reconciliation may create a new transcript revision; it does
  not rewrite the first-pass engine history silently.

## 7. Hybrid AI adapter

```ts
interface JournalAI {
  transcribe(input: AudioFrameStream, options: TranscriptionOptions):
    AsyncIterable<TranscriptEvent>;
  organize(input: OrganizeInput, execution: "local" | "node" | "auto"):
    AsyncIterable<OrganizationEvent>;
  cancel(operationId: string): Promise<void>;
}
```

These are app-side abstractions, not claims about current SDK method names.
The adapter maps them to the installed Hybrid AI version and records that version
in validation evidence. Journal-specific JSON schemas will live under a future
`schemas/journal/v1/` directory after the contract ADR is approved.

An `OrganizeInput` contains selected finalized transcript text, stable entry and
segment references, locale/time-zone context, and user-selected output kinds.
It excludes original audio unless a later approved contract explicitly requires it.

The result validator enforces:

- known schema/version and bounded sizes/counts;
- source references limited to the selected entries/segments/time ranges;
- every voice-derived task has at least one exact, playable audio range;
- no invented local IDs or mutation instructions;
- one atomic persisted derivation revision only after terminal validation.

## 8. App lock and key lifecycle

```text
UNCONFIGURED -> LOCKED -> UNLOCKING -> UNLOCKED
                    ^        |            |
                    |        +-- failure -+
                    +---- lifecycle/relock+
```

- Setup creates a local PIN/passcode; no identity record is created.
- PIN is processed through the approved KDF/key-unlock design and never stored
  or logged in plaintext.
- Biometrics invoke platform APIs that release/authorize local key access. The
  app receives no biometric template or sensor material.
- Biometric invalidation returns to PIN fallback.
- Background snapshots are obscured immediately. The unlock session follows a
  configurable timeout; the initial target default is a short grace period.
- Lockout/backoff and reset semantics are blocked on the security ADR.

AJ-0 implements this state machine and lifecycle relock behind
`LockCredentialStore` and `BiometricAuthenticator` ports. Its default
`VolatileCredentialStore` retains only a non-cryptographic verifier for the
current process and is explicitly test/scaffold code—not the implementation of
the frozen production security properties. Android applies `FLAG_SECURE`; a JS
privacy curtain covers inactive/background lifecycle states.

## 9. Startup and recovery

1. Enter locked shell and obscure protected content.
2. After unlock, open/decrypt storage and run transactional migrations.
3. Reconcile recording rows in nonterminal states with files in the recording root.
4. Promote valid finalized files, expose recoverable partial files, and quarantine
   malformed/unknown files without deleting them automatically.
5. Resume no AI operation automatically unless a future explicit policy permits it.

## 10. Error model

| App error | User behavior |
|---|---|
| `LOCK_AUTH_FAILED` | Stay locked; allow bounded retry/PIN fallback. |
| `LOCK_KEY_UNAVAILABLE` | Fail closed; explain local reset consequences. |
| `MICROPHONE_DENIED` | Offer written entry/settings guidance. |
| `RECORDING_INTERRUPTED` | Preserve/finalize recoverable source and explain status. |
| `STORAGE_EXHAUSTED` | Stop safely, preserve valid prefix if possible, prevent AI work. |
| `TRANSCRIPTION_UNAVAILABLE` | Keep recording; offer retry later. |
| `NODE_UNAVAILABLE` | Keep source; allow later organization retry. |
| `AI_RESULT_INVALID` | Persist no derivation; retain source and diagnostics code only. |
| `MIGRATION_FAILED` | Do not mutate/delete data; enter recoverable error state. |

## 11. Diagnostics and privacy

Allowed: app/SDK version, request/operation ID, capability/version, target,
durations, event counts, recording duration/byte count, error code, and hashed
local IDs where necessary.

Forbidden by default: audio, transcript/entry/task text, derived payloads, PIN,
keys, biometric results beyond ephemeral control flow, node secrets, QR data,
full file paths, or arbitrary SDK error messages that may contain payload data.

## 12. Testing seams

- Fake clock, random/ID source, secure store, biometric prompt, recording service,
  file store, database, Hybrid AI adapter, lifecycle, and storage monitor.
- State-machine tests for recording, transcript revisions, lock/relock, and deletion.
- Contract fixtures for valid/malformed derivations and provenance escapes.
- Crash/restart reconciliation with database/file failures at every transition.

## 13. Backup and restore service

```ts
interface BackupService {
  estimate(): Promise<BackupEstimate>;
  create(options: BackupCreateOptions): AsyncIterable<BackupEvent>;
  inspect(source: UserSelectedFile, secret: BackupSecret): Promise<BackupPreview>;
  restore(source: UserSelectedFile, secret: BackupSecret): AsyncIterable<RestoreEvent>;
}
```

The app-side interface receives a strong backup password or generated recovery
key through short-lived sensitive input. It never defaults to the short app PIN.
The concrete cryptographic/container format is blocked on the security ADR.

Logical export pipeline:

```text
estimate -> consistent DB snapshot -> enumerate referenced recordings
         -> stream authenticated encryption -> finalize archive
         -> reopen/authenticate/checksum -> platform save destination -> complete
```

Logical restore pipeline:

```text
select archive -> authenticate header/manifest -> preview
               -> validate empty-vault + disk/version/bounds
               -> stream into isolated staging vault
               -> validate DB/files/provenance -> atomic activate -> complete
```

Rules:

- Archive events expose phase, processed/total bytes, and typed error only; no content.
- One consistent snapshot must reference exactly the recording set in the archive.
- Recordings stream in bounded chunks; no entire recording/archive in JS memory.
- No plaintext temporary DB export, audio copy, manifest, or journal payload.
- Cancel/failure removes app-private temporary ciphertext and leaves journal unchanged.
- Final success requires reopening the output and authenticating every index/object.
- Restore rejects unsupported versions, excessive sizes/counts, duplicates, path
  traversal, invalid IDs/references, checksum/authentication failure, and low storage.
- Staging uses new local IDs/paths only as defined by the frozen archive mapping;
  v0.1 does not merge into a non-empty vault.
- App PIN/biometric secure-store records and node pairing state never cross the
  backup boundary. A restored journal uses newly created local lock keys.
