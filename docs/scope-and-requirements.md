# Scope and Requirements

> **ADR-021 authority (2026-10-12):** Audio Journal owns no model runtime.
> Transcription and organization run through packaged Hybrid AI SDK
> capabilities. The real-inference migration supports explicit `local` and
> `node`; `auto` is deferred. See
> [real-inference-migration.md](real-inference-migration.md).

## 1. Product statement

Audio Journal lets a person privately capture voice or written entries, preserve
the originals, review timestamped transcripts, and optionally organize selected
material into useful views and tasks through Hybrid AI.

## 2. v0.1 objectives

1. Capture and durably persist voice and written journal entries.
2. Show live, timestamped transcription without coupling recording durability to STT.
3. Preserve original material and provenance for every derived item.
4. Provide raw Diary mode and explicit Organized mode.
5. Work offline for capture, browsing, playback, editing, and local unlock.
6. Transcribe on-device through SDK `audio.transcribe@1`, and organize through
   SDK `journal.organize@1` using an explicit local or Private Node target.
7. Provide local PIN/passcode locking with optional biometric convenience unlock.
8. Validate the Hybrid AI SDK as an external packaged consumer.

## 3. In scope

- React Native mobile app for Android and iOS using the New Architecture.
  Android is the first/current validation profile only; iOS remains a supported
  product target and must pass its cumulative gate before cross-platform or
  release claims.
- Voice recording, pause/resume, safe finalization, playback, and written entries.
- Timestamped live/provisional and finalized transcript segments.
- Local entry timeline, search over local metadata/text, and entry detail.
- Explicit organization into summaries, topics, sections, tasks, people,
  projects, work, personal, and ideas when returned by a valid capability.
- Provenance from derived artifacts/tasks to entry, transcript range, and audio time.
- Local SQLite persistence plus app-private recording files.
- User-created portable encrypted full-journal backup and empty-vault restore.
- Local PIN/passcode and optional biometric unlock.
- Hybrid AI explicit `local` and `node` execution through public APIs. `auto`
  remains deferred from the real-inference prototype.
- Real model-backed local transcription and local/node organization, with exact
  model/profile identity and reproducible accuracy evidence.
- Paired Private AI Node discovery/status/pairing/forget flows when SDK support is ready.
- Prototype Private AI Node reachability through separately installed
  Tailscale clients on Android and the desktop node host, using an explicit
  MagicDNS/IP endpoint and preserving SDK pairing/mTLS. Validate direct and
  relayed paths first on Linux/Ubuntu; Windows/macOS node support follows its
  native SDK validation gates without changing AJ.
- Privacy-safe diagnostics that exclude journal content and credentials.
- A versioned, bounded AJ capability data bundle that the already-built generic
  node can validate/install without compiling AJ source or receiving user data.

## 4. Explicitly out of scope for v0.1

- Accounts, profiles, sign-up, sign-in, email recovery, or identity backend.
- Public cloud AI APIs, cloud fallback, application-level relay service, or
  public content storage. The external Tailscale peer/DERP transport profile
  carries the existing paired mTLS protocol and is not an AJ relay feature.
- Cross-device synchronization, automatic/hosted backup service, sharing,
  collaboration, or social features. User-directed encrypted archive export and
  restore remain in scope.
- Automatic continuous analysis of all journal entries.
- AI therapy, medical diagnosis, crisis detection, or clinical claims.
- Mood scoring, sentiment surveillance, or behavior profiling by default.
- Calendar/email integrations, notifications derived from external accounts, or team workflows.
- Editing or deleting source audio as a side effect of transcript/AI edits.
- SDK-private imports or journal-specific logic added to Hybrid AI SDK core.
- App-owned model runtimes, direct model-server APIs, raw-audio node upload,
  and `aj.rules` as a production organization engine.
- Private AI Node desktop service implementation, networking framework,
  TLS/crypto, model host, OS service adapters, credential protection, and
  native packages; these belong to the Hybrid AI SDK repository and its
  `technology-stack.md`.
- Embedded Tailscale libraries, Tailscale control-plane APIs, or treating
  tailnet membership as application/node authentication.
- Node-initiated requests for additional journal data or device capabilities.
  This is a future consented, typed, bounded protocol; AJ-RI sends only the
  user's initially selected input.
- Prototype performance/accuracy recordings longer than 180 seconds; long
  journal chunking and extended soaks are future development work.
- A self-describing incomplete backup archive. In v0.1 an export that skips
  damaged entries (after typed confirmation) is marked incomplete only on its
  result screen, in its `-incomplete` file name, and in local backup history.
  A renamed or moved copy cannot prove the omission. This is left to a future
  AJB2 (`AJ1-DEC-001`, option B).

## 5. Functional requirements

### Capture and source integrity

| ID | Requirement |
|---|---|
| AJ-FR-001 | Create voice and written entries without a network or node. |
| AJ-FR-002 | Persist audio independently of transcription and AI execution. |
| AJ-FR-003 | Support pause, resume, finish, cancellation with confirmation, and interruption recovery. |
| AJ-FR-004 | Keep original audio immutable through transcript correction and reorganization. |
| AJ-FR-005 | Record entry and recording timestamps and stable local identifiers. |

### Transcript and provenance

| ID | Requirement |
|---|---|
| AJ-FR-010 | Display provisional transcript text while recording when STT is available. |
| AJ-FR-011 | Store finalized transcript segments with start/end audio offsets. |
| AJ-FR-012 | Allow transcript correction without claiming the correction is original STT output. |
| AJ-FR-013 | Link every derived artifact and task to its source entry and relevant segments/time ranges. |
| AJ-FR-014 | Preserve source content when transcription fails, is cancelled, or is retried. |

### Journal and organization

| ID | Requirement |
|---|---|
| AJ-FR-020 | Diary mode stores entries without forced categorization or analysis. |
| AJ-FR-021 | Organized mode runs only after explicit user action on selected content. |
| AJ-FR-022 | Derived organization is revisioned/replaceable and never overwrites source material. |
| AJ-FR-023 | Users can inspect the source context for a derived item or task. |
| AJ-FR-024 | AI failure leaves the entry readable and retryable. |
| AJ-FR-025 | Every extracted voice task stores a transcript-segment reference and exact audio start/end offsets, and the task UI can play that cited excerpt. |

### Security and privacy

| ID | Requirement |
|---|---|
| AJ-FR-030 | Require no account, sign-up, or sign-in. |
| AJ-FR-031 | Provide a local PIN/passcode lock and optional platform biometric convenience unlock. |
| AJ-FR-032 | Always provide PIN/passcode fallback after biometric unavailability or failure. |
| AJ-FR-033 | Never store plaintext PIN/passcodes or raw biometric data/templates. |
| AJ-FR-034 | Gate protected screens and journal-data operations while locked. |
| AJ-FR-035 | Perform unlock offline without initializing Hybrid AI or contacting a node. |

### Hybrid AI integration

| ID | Requirement |
|---|---|
| AJ-FR-040 | Consume a pinned packaged SDK version through public APIs only. |
| AJ-FR-041 | Display user-appropriate offline/node-unavailable behavior without losing source data. |
| AJ-FR-042 | Allow cancellation of transcription and organization operations. |
| AJ-FR-043 | Validate application-owned capability results before persistence. |
| AJ-FR-044 | Send only the selected minimum content to the paired Private AI Node. |
| AJ-FR-045 | Never fall back to a public cloud endpoint. |

### Backup and restore

| ID | Requirement |
|---|---|
| AJ-FR-050 | Create a portable encrypted full-journal backup through the platform document picker. |
| AJ-FR-051 | Include recordings, written entries, transcripts/corrections, organized views, tasks, and exact provenance. |
| AJ-FR-052 | Exclude PIN/biometric material, device-bound keys, logs, caches, and Private AI Node pairing credentials. |
| AJ-FR-053 | Protect the archive with a strong backup password or generated recovery key independent of the short app-lock PIN. |
| AJ-FR-054 | Verify the completed backup can be reopened, authenticated, and checksummed before reporting success. |
| AJ-FR-055 | Restore only after archive/version/integrity/storage validation, using staging and atomic activation. |
| AJ-FR-056 | Support v0.1 restore into an empty journal after app-data clear/reinstall; require new local lock setup and node re-pairing. |

## 6. Non-functional requirements

| Area | Requirement |
|---|---|
| Privacy | Journal content and credentials are excluded from logs, analytics, crash metadata, and screenshots used in validation. |
| Reliability | A completed recording survives app restart, STT failure, node failure, and derived-data deletion. |
| Performance | Recording UI remains responsive; AI work cannot block audio persistence or primary navigation. |
| Offline | Capture, unlock, browse, edit, and playback work without network access. |
| Accessibility | Lock, recording, playback, transcript, and task flows support screen readers, dynamic type, and non-color status cues. |
| Portability | Android and iOS use aligned domain behavior; platform-specific audio/security adapters are permitted. |
| Testability | Domain, repositories, security policy, capability adapters, and view models have injectable boundaries. |
| Data integrity | Database migrations are transactional; file/database reconciliation is deterministic and recoverable. |
| Portability | The frozen backup version restores across supported Android and iOS profiles. |
| Product isolation | AJ consumes public SDK packages only and ships no SDK/node private source, desktop server, historical companion, or model runtime after the owning migration gate. |

## 7. v0.1 acceptance

- A fresh install creates a local PIN without account or network access.
- PIN unlock works; supported biometrics can be enabled and fall back safely.
- A user records, pauses/resumes, sees live transcript when available, finishes,
  restarts, and can play the intact recording and inspect timestamped text.
- A written or voice entry can remain an unprocessed diary entry indefinitely.
- Explicit organization creates valid derived views/tasks with source links.
- With no node, diary functionality remains available and organization fails clearly.
- With a paired compatible node, organization streams and completes only through
  the public Hybrid AI API.
- Cancellation, interruption, malformed AI output, storage pressure, and app
  restart do not corrupt source entries.
- A verified encrypted backup restores byte-identical recordings, journal data,
  organized views, tasks, and source references after app data is cleared,
  without restoring device-bound lock or node credentials.
