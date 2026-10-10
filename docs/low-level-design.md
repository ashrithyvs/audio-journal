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

### 5.1 AJR1 recording container (ADR-017, amended 2026-10-10)

The implementation is `android/app/.../recording/Ajr1.kt`. The vectors in
`schemas/ajr1/v1/` come from the independent Node reference
(`tools/ajb1-reference/lib/ajr1.mjs`), and a JVM test rebuilds every vector
file byte for byte. Integers are big-endian.

**Header (64 bytes).**

| Offset | Size | Field | Value |
|---:|---:|---|---|
| 0 | 4 | magic | `AJR1` |
| 4 | 2 | version | `1` |
| 6 | 2 | header length | `64` |
| 8 | 4 | sample rate | `16000` |
| 12 | 1 | channels | `1` |
| 13 | 1 | sample format | `1` = s16le |
| 14 | 2 | reserved | `0` |
| 16 | 16 | `fileSalt` | 16 fresh CSPRNG bytes per file |
| 32 | 4 | `noncePrefix` | random |
| 36 | 4 | maximum chunk bytes | `32000` (1 s) |
| 40 | 24 | reserved | zero |

Readers reject any other value.

**Key.**

```text
K_file = HKDF-SHA256(ikm = HKDF(MK, "aj-rec-v1"), salt = fileSalt,
                     info = u16(35) || "audio-journal/ajr1/recording-key/v1"
                            || u16(30) || recordingId)
```

The key exists only while the recording is open. Closing the writer, or
locking the vault, zeroes it.

**Frame.** Each frame is `u64 index || u32 length || ciphertext || tag(16)`,
where:

- `nonce = noncePrefix || u64(index)`;
- `aad = SHA-256(header) || u8(30) || recordingId || u64(index) ||
  u32(length)`;
- `length` is even and between 2 and 32 000.

**Rules:**

- Indices strictly increase from 0, and gaps are allowed. A reader stops at
  the first duplicate or decrease (`INDEX_ORDER`), at an index above
  `2^48 − 1` (`INDEX_OVERFLOW`), at an invalid length (`CHUNK_LENGTH`), at
  a torn frame (`TORN`), or at an authentication failure (`AUTH_FAILED`).
- Everything before the stop point is authenticated audio. Everything after
  it is trailing bytes.
- Each frame is written and then fsync'd. Only complete frames count.
- **Resume after a crash.** The writer truncates the file to the
  authenticated prefix and continues at:
  - `last + 1` when there are no trailing bytes;
  - otherwise `max(last + 2, tornIndex + 1)`, so an index a torn write may
    have consumed is never reused.

  The writer refuses to pass `2^48 − 1`.
- **Recreating a file** always draws a new salt, and therefore a new key.
- **Reads stream** from disk (`Ajr1.FileSource`), so a 60-minute recording
  (about 115 MB) is never loaded into memory whole.

**Tests:** `Ajr1Test` (JVM) covers:

- identical nonce prefixes in different recordings;
- one recording ID with different salts;
- a wrong ID, salt, header, or index;
- duplicate, decreasing, and reordered indices;
- torn-tail index skipping;
- file recreation;
- the maximum index and overflow.

`Ajr1VectorsTest` checks the Kotlin codec against the Node reference.

### 5.2 Android capture and playback (AJ-1)

The native code is in `android/app/.../recording/`, behind the
`AudioJournalRecordings` TurboModule (`src/native/NativeAudioJournalRecordings.ts`).
JavaScript reaches it through `NativeRecordingService` and
`NativePlaybackService` in `src/platform/recording/`.

- **Capture (`CaptureSession`).** `AudioRecord` delivers 16 kHz mono s16le
  in 100 ms reads into a 1-second chunk buffer.
  - Each full chunk is sealed as one AJR1 frame and fsync'd. Pause, finish,
    a limit, and close seal the partial chunk, so nothing captured before
    the last seal is lost.
  - Plaintext lives only in the chunk buffer, which is zeroed after each
    seal.
  - The session stops capturing at the ADR-017 limits by itself (60 minutes;
    free space below 50 MiB) and reports progress; JavaScript then
    finishes.
  - `finish()` reads the file back. It succeeds only if every frame written
    authenticates with nothing after it, and the digest and length then
    come from that scan.
- **Interruptions.** Each of these pauses with a reason:
  - losing audio focus (`audio_focus_lost`);
  - being silenced by a higher-priority capture on Android 10+ (also
    `audio_focus_lost`);
  - leaving the foreground (`backgrounded`).

  Without focus at start, the capture starts paused. Resuming is always the
  user's choice.
- **Microphone permission.** It is requested only when recording is first
  invoked, before any journal row exists. The dialog is covered by the lock
  grace (§8.1).
- **One control thread (`ActiveAudio`).** It owns the single capture and
  the single playback. The vault's lock and erase submit their close to
  this thread, so locking never races a pause or a finish. Closing seals
  what was captured and zeroes the recording key.
- **Startup scan (`RecordingFiles.scan`).** Unfinished captures are
  authenticated frame by frame. Every other file is checked by header and
  length against its stored `byteCount`, so unlock time does not grow with
  the archive.
  - `tail` classifies what follows the authenticated frames: `none`,
    `torn` (a write cut short), or `damaged`.
  - Only a torn final frame is ever truncated. Unknown files are moved to
    `recordings-quarantine/`, never deleted.
- **Playback (`PlaybackSession`).** `Ajr1Reader` finds frames by header,
  then authenticates each frame in the requested range as it reads it.
  - PCM goes to an `AudioTrack` in 100 ms slices.
  - Pause stops at the current position and reports it.
  - A frame that fails authentication ends playback with `SOURCE_DAMAGED`;
    the file is never changed.

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

**AJ-1 implementation (ADR-016, ADR-017):**

- **Final pass.** `TranscriptionController` runs one pass at a time.
  - It starts after a capture is saved and after each unlock (§9 step 5);
    the user can cancel it or try again.
  - Native code (`AudioJournalSpeech.transcribeRecording`) decrypts the
    sealed AJR1 file in windows (`RecordingPass`) straight into whisper.cpp,
    so a 60-minute recording never becomes one float array.
  - **Windows** are at most 5 minutes. Each cut moves to the latest
    quietest 20 ms within the 2 s before the nominal cut, and segment times
    are clamped to their window. These are PROVISIONAL defaults, chosen for
    memory; transcript quality across cuts is checked in validation evidence.
  - The result is validated (`validateEngineSegments`) before it is stored
    as a new engine revision.
  - **Non-speech annotations.** whisper.cpp marks stretches without speech
    with a bracketed annotation (`[BLANK_AUDIO]`, `[ Silence ]`,
    `(wind blowing)`). A segment whose whole text is one such annotation is
    dropped like an empty segment (`isSpokenText`), in the final pass and in
    live text. Text that only contains brackets is kept. A pass with no
    other segments is an empty pass ("No speech was found").
  - Every completed pass, empty ones included, is logged in
    `transcript_passes` (migration 2), so silence is not transcribed again.
  - Locking the vault cancels a running pass and zeroes its key
    (`RecordingJobs`).
- **Live text.** `LiveTranscriber` copies capture PCM through a
  non-blocking tap into a ring buffer.
  - It transcribes the latest window on its own thread, skipping ahead
    while the engine is busy.
  - **PROVISIONAL parameters** (Open decision 3): an 8 s window, a 4 s
    cadence, 2 threads, and the default model, until device measurements.
  - `planLiveWindow` resolves overlaps (the newer window wins).
  - `LiveTranscriptController` stores live rows in batches; the final pass
    supersedes them.

## 7. Hybrid AI adapter

Transcription is not part of this adapter (ADR-016). It lives behind the
app-owned port below. Its first implementation transcribes 16 kHz mono PCM
files with on-device whisper.cpp, emits each segment as it is decoded, and
supports cancellation:

```ts
interface TranscriptionService {
  models(): Promise<TranscriptionModelInfo[]>; // id, sha256, bytes, available
  transcribe(request: {
    requestId: string;
    audioPath: string;         // app-private 16 kHz mono PCM WAV
    model: 'base.en-q5_1' | 'tiny.en-q5_1';
    threads?: number;
  }, onSegment: (segment: {t0Ms: number; t1Ms: number; text: string}) => void):
    Promise<TranscriptionResult>; // segments, timings, peak memory
  cancel(requestId: string): void;
}
```

```ts
interface JournalAI {
  organize(input: OrganizeInput, execution: "local" | "node" | "auto"):
    AsyncIterable<OrganizationEvent>;
  cancel(operationId: string): Promise<void>;
}
```

These are app-side abstractions, not claims about current SDK method names.

### 7.1 Implemented AJ-3 node adapter (ADR-015)

The AJ-3 node workflow uses an implemented port, `HybridAiGateway`
(`src/platform/hybrid-ai/HybridAiGateway.ts`). Its single production adapter
calls only the `@hybrid-ai/react-native` 0.1.0-m5 public root:

| Port operation | Public SDK call |
|---|---|
| `initialize(policy)` | `createHybridAI({pairing: true, policy})`, then `capabilities()` |
| `setPolicy` | `setPolicy` |
| `status`, `pairedNodes`, `capabilities` | `node.status()`, `node.pairedNodes()`, `capabilities()` |
| `startDiscovery` | `node.startDiscovery()`; async events become callbacks |
| `inspectPairingCode` | `node.parseBootstrap(qrText)` |
| `pair` | `node.pair(qrText, {deviceName, activate: true})` with `confirm`, `reject`, `cancel` |
| `connect`, `setActive`, `forget` | `node.connect`, `node.setActive`, `node.forget` |
| `run`, `cancel` | `stream(request)` and `cancel(requestId)` |

**Link status after requests** (UX §7.1). The SDK's `node.status()` changes
only on connect, refresh, and rotation (SDK-AJ-2), so the reducer keeps two
marks beside it:

- a failure mark (`LinkFailureMark`) set by a link-code failure; it
  overrides a stale "connected" until fresh authenticated contact, and
  `PrivateNodeContext` makes one debounced, single-flight reconciling
  connect;
- a contact mark (`LinkContact`) set by a request the node completed, with
  the SDK status at that time; the node shows Connected while the SDK
  repeats that status. One catch-up connect follows: coalesced, scheduled
  after the remaining debounce instead of being dropped, skipped when a
  connect is in flight or the SDK already reports connected, and cancelled
  on lock.

Each mark supersedes the other for the same node, and clearing a failure
mark also clears the failed connect that set it. Requests are never retried.

Failures surface as `HybridAiFailure {code, localReason?, nodeReason?}`.
Codes are public SDK codes, plus the app-only `SDK_INITIALIZATION_FAILED`,
`SDK_NOT_INITIALIZED`, and `INVALID_RESULT`. `run` delivers exactly one
terminal update even when the stream throws or ends early. Paired-node
records expose no pairing ID or rotation material to the app.

Feature state lives in a pure reducer
(`src/features/private-node/domain/privateNodeState.ts`) driven by
`PrivateNodeProvider`. The reducer covers:

- the SDK phase: `idle`, `initializing`, `ready`, or `unavailable`;
- discovery: `idle`, `searching`, `stopped`, or `failed`;
- the pairing ceremony: `inspecting`, `ready`, `pairing`, then `confirming`
  with a single decision, ending `paired`, `failed`, or `cancelled`;
- link operations: `connecting` and `forgetting`;
- one capability request: `running`, ending `completed`, `failed`, or
  `cancelled`;
- development timings.

Asynchronous guards use refs, not render state, so back-to-back actions are
safe. Error copy comes from `errorPresentation.ts`, which covers every code in
the packaged SDK's `ERROR_CODES` table and every `NODE_REASONS` value.

The adapter maps them to the installed Hybrid AI version and records that version
in validation evidence. The journal-specific contract is frozen in
`journal-organize.md` (ADR-019), with its schemas and vectors in
`schemas/journal/v1/`; for `journal.organize@1` it supersedes the
`OrganizeInput` and validator sketch below wherever they differ.

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
- Lockout/backoff, PIN change, and reset follow ADR-017.

AJ-0 implemented this state machine and lifecycle relock with a volatile
verifier. Android applies `FLAG_SECURE`, and a JS privacy curtain covers
inactive and background lifecycle states.

### 8.1 AJ-1 implementation (ADR-017; not yet accepted)

The AJ-0 `LockCredentialStore` and `BiometricAuthenticator` scaffolds, and
the volatile verifier, are replaced by the `VaultService` port
(`src/features/app-lock/ports/VaultService.ts`).

**`AppLockProvider` over the vault:**

- It maps the vault's outcomes to the lock reducer: `unlocked`,
  `wrong_pin` with an optional `retryAt`, `refused` with `retryAt`,
  `unavailable` (which fails closed), and biometric `invalidated`, which
  turns biometrics off and shows PIN fallback.
- Every lock, manual or lifecycle, also calls `vault.lock()`. That zeroes
  MK and closes the database natively.

**Native vault** (`android/.../vault/`):

- `Vault` is pure Kotlin, with JVM tests behind small interfaces:
  - `DeviceSealer`: in production, a non-exportable Keystore AES-256-GCM key.
  - `PinKdf`: in production, Argon2id from the reference libargon2 20190702,
    built by `android/vault-crypto` from its SHA-256-pinned archive.
  - `BiometricKeys`: in production, a Keystore key requiring
    `BIOMETRIC_STRONG` authentication per use, invalidated by enrollment
    changes, and used through a `BiometricPrompt` `CryptoObject`.
- **Vault file** (`no_backup/vault/vault.bin`): a device-sealed `AJV1`
  record holding:
  - the Argon2id identity, `m/t/p`, and salt;
  - the PIN-wrapped MK, whose AAD binds the KDF identity and parameters;
  - the failure counter and last-failure time;
  - the optional biometric copy.
- **File writes** are atomic: write a temporary file, fsync it, and rename.
- **Clock rollback** restarts the lockout window from the current time.
- **Parameter changes.** The provisional parameters (19 456 KiB, t = 2,
  p = 1) are not frozen. A successful PIN unlock rewraps the PIN copy
  whenever the parameters change.
- **Biometric invalidation** is detected when the cipher is initialized,
  including at status time. The biometric copy and its key are deleted, and
  the PIN copy is never touched.
- **Biometric availability** is re-read from the vault status after first-run
  setup and after every unlock. First-run setup starts with no vault to probe,
  and enrollment can change while the app is away, which locks it.

**Journal store:**

- `JournalDatabase` is SQLCipher, keyed natively with the raw
  `HKDF(MK, "aj-db-v1")` key, in WAL mode with foreign keys on.
- All operations, including close on lock, run on one thread, because
  Android SQLite transactions are thread-bound.
- JavaScript reaches it through `SerialSqlDatabase`, the same serializing
  and transaction wrapper the tests use, over a JSON TurboModule driver.

**Opening the journal.** `JournalGate` mounts only while the app is
unlocked. It opens the database, runs migrations, reconciles recordings,
and closes everything on lock. If opening or migrating fails, nothing
changes and the user sees a recoverable error.

**Lock grace for the app's own system UI** (ADR-017, owner decision of
2026-10-10):

- Before the app opens its microphone permission dialog or a system document
  picker, it registers an expected interruption. The resulting non-active app
  state then does not lock.
- The grace ends when the app is active again, or after 2 minutes, whichever
  comes first. At the 2-minute mark the app locks even if the system UI is
  still open.
- Any non-active state with no registered interruption locks immediately, as
  before.
- The privacy curtain and `FLAG_SECURE` do not change.
- Tests cover all of these: grace, cap, expiry, and an unregistered
  backgrounding.

Erase journal and the biometric toggle have UI (checkpoint 2). Device
evidence is in `validation/AJ1-progress.md`.

## 9. Startup and recovery

1. Enter locked shell and obscure protected content.
2. After unlock, open/decrypt storage and run transactional migrations.
3. Reconcile recording rows in nonterminal states with files in the recording root.
4. Promote valid finalized files, expose recoverable partial files, and quarantine
   malformed/unknown files without deleting them automatically.
5. Resume no AI operation automatically unless a future explicit policy permits it.
   **Explicit policy** (ADR-017, owner decision of 2026-10-10):
   - After each unlock, ready recordings without a full transcription pass
     are queued for the on-device final pass, one at a time.
   - Queued passes are cancellable and never block capture.
   - A pass that failed in this session is retried only when the user asks.
   - Nothing else resumes automatically: no Hybrid AI work, and no node work.
6. **Interrupted captures** (ADR-017, owner decision of 2026-10-10). An
   unfinished capture whose authenticated frames end cleanly, or end in a
   torn final frame, is promoted at reconciliation:
   - the torn frame is dropped first;
   - the recording becomes `ready` with finish reason `recovered`, and its
     digest and length come from the authenticated frames.

   An authentication or ordering failure before the end of the file is
   damage. The recording stays `recoverable` ("needs attention"), and no
   byte is removed.

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
| `INVALID_RESULT` | Persist no derivation; retain source and diagnostics code only (`journal-organize.md` §6). |
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
- **AJ-1 device journeys** (`e2e/aj1/`) use the shared `e2e/android/` driver
  read-only.
  - A screen that changes every second (the recording timer, the playback
    position) never gives `uiautomator dump` its one-second idle window.
  - Those screens are read through `e2e/aj1/tools/LiveDump.java`, which the
    journeys build on first use (`javac` and `d8`) and run from the shell with
    `app_process`. It reads the accessibility hierarchy without waiting for
    idle and never acts on it.
  - The transcript section's `transcript-kind-<kind>` testID distinguishes a
    final or empty pass from a live draft.
  - The emulator's microphone is silent, so real speech reaches the final
    pass through `RecordingSpeechDeviceTest`: `e2e/aj1/speech.mjs` pushes
    whisper.cpp's `jfk.wav` (SHA-256 pinned), the test seals it into AJR1, and
    the production `RecordingPass` decodes it in one window and across a
    forced cut.

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

### 13.1 Android AJB1 codec and procedures (AJ-1)

The codec is native, so PCM and keys never reach JavaScript. It lives in
`android/app/.../backup/`, and it must pass the frozen vectors
(`Ajb1VectorsTest`) and rebuild the reference archive byte for byte
(`BackupCodecTest`).

- **Parts:**
  - `CanonicalJson`: the §9.4 profile, with strict decoding;
  - `BackupSecrets`: the BIP-39 wordlist pinned by SHA-256, NFC passwords,
    and ECMAScript whitespace rules;
  - `Ajb1`: the header, the §9.10 pre-KDF checks in order, and the injectable
    PROVISIONAL KDF policy;
  - `SegmentWriter` and `SegmentReader`: one segment in memory;
    `authenticateAll` runs before parsing, so §9.10's AUTH_FAILED-first
    order holds;
  - `Ajb1Parser`: streams sections with bounded memory, deferring
    RECORDS-line errors so it reaches the reference parser's verdict;
  - `Ajb1Records`: §9.6 field and cross-record checks.
- **Export (`BackupExporter`).**
  - Pass 1 reads one snapshot. It takes digests of ready recordings from the
    database and frame lengths from AJR1 headers, and hashes the
    authenticated prefix of recoverable ones. It then validates every
    record, applies the limits, and sizes the archive, all before any KDF.
  - A recording that cannot be read raises `Damaged`, listing the entry and
    recording. That entry, its recording, and its segments are excluded
    together, and only when the user explicitly confirms (owner decision
    2026-10-10; `AJ1-DEC-001` option B: the result, the file name, and
    local history carry the mark, not the archive).
  - Pass 2 re-serializes from the same snapshot (it must hash to the pass-1
    digest) and streams PCM natively. Each recording must match its digest.
- **Restore (`BackupRestorer`).** `open` runs the pre-KDF checks, the KDF,
  the unwrap, a full authentication pass, and reads the manifest for the
  preview. `stage` streams the archive again, re-authenticating every
  segment, into a staging sink.
- **Staging and activation.**
  - The staging vault (`restore/staging-<128-bit hex>/`) has a fresh
    in-memory master key, its own SQLCipher database, and re-encrypted AJR1
    files.
  - The staging database copies the open, migrated journal's schema and
    migration history (`sqlite_master` in creation order), so migrations
    exist only in JavaScript.
  - Activation follows §9.10 steps 6–7: the current PIN, a written vault
    record, a synced marker, renames, and cleanup. Startup completes it, or
    deletes staging, so it is never half done.
