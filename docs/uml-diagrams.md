# UML and Behavioral Diagrams

## 1. System context

```mermaid
flowchart LR
    User[Journal user] --> App[Audio Journal]
    App <--> Store[(Local private storage)]
    App --> SDK[Hybrid AI SDK public API]
    SDK --> Local[On-device capability]
    SDK --> Node[Paired Private AI Node]
```

The node is the external SDK-owned native `private-ai-node` product on Linux,
Windows, or macOS. Its service, networking, TLS, model host, operator CLI, and
platform adapters are intentionally outside the AJ component boundary and are
diagrammed in `hybridAi/docs/uml-diagrams.md` §4a–4b.

```mermaid
flowchart LR
    AJRepo[Audio Journal repository]
    App[AJ Android/iOS application]
    Bundle[Declarative capability data bundle]
    SDKPkg[Packaged Hybrid AI SDK]
    Node[Already-built generic Private AI Node]

    AJRepo --> App
    SDKPkg -->|public API only| App
    AJRepo --> Bundle
    Bundle -->|validated data install; no recompile| Node
```

## 2. Component diagram

```mermaid
flowchart TB
    Screens[React Native screens]
    Features[Feature controllers / React contexts / transient UI state]
    Domain[Domain services]
    JournalRepo[Journal repository]
    TranscriptRepo[Transcript repository]
    DerivationRepo[Derivation repository]
    DB[(SQLite)]
    FileStore[(Recording file store)]
    Recorder[RecordingService]
    Security[AppLock / KeyStore]
    SecureStore[(Platform secure storage)]
    AI[HybridAIAdapter]
    SDK[Packaged Hybrid AI SDK]

    Screens --> Features --> Domain
    Domain --> JournalRepo --> DB
    Domain --> TranscriptRepo --> DB
    Domain --> DerivationRepo --> DB
    JournalRepo --> FileStore
    Features --> Recorder --> FileStore
    Screens --> Security --> SecureStore
    Features --> AI --> SDK
    Recorder --> AI
```

## 3. Recording and transcription sequence

```mermaid
sequenceDiagram
    actor User
    participant UI
    participant Repo as JournalRepository
    participant Rec as RecordingService
    participant SDK as Hybrid AI SDK audio.transcribe@1 (local, ADR-021)

    User->>UI: Start recording
    UI->>Repo: createVoiceDraft()
    UI->>Rec: prepare() / start()
    Rec-->>UI: recording started
    loop while recording
        Rec-->>UI: level + timestamped audio frame
        UI->>SDK: offer bounded local audio source
        SDK-->>UI: provisional/final timestamped segment
        UI->>Repo: batch segment update
    end
    User->>UI: Finish
    UI->>Rec: finish()
    Rec-->>UI: finalized recording
    UI->>Repo: finalizeVoice()
    Note over UI,SDK: SDK STT failure never cancels or deletes recording. Raw audio never goes to the node.
```

## 4. Organization sequence

```mermaid
sequenceDiagram
    actor User
    participant UI
    participant Repo as Repositories
    participant AI as HybridAIAdapter
    participant SDK as Hybrid AI SDK
    participant Local as SDK local model
    participant Tailnet as Tailscale (direct or relay)
    participant Node as Generic Private AI Node model

    User->>UI: Organize selected entry/range
    UI->>Repo: load finalized transcript + source refs
    UI->>AI: organize(validated selection)
    AI->>SDK: journal.organize@1 via public API, explicit local or node
    alt local
        SDK->>Local: validated capability package + text/provenance
        Local-->>SDK: real structured model events/result
    else node
        SDK->>Tailnet: paired mTLS request to configured endpoint
        Tailnet->>Node: text/provenance only
        Node-->>Tailnet: real structured model events/result
        Tailnet-->>SDK: unchanged encrypted stream
    end
    SDK-->>AI: events
    AI-->>UI: safe progress only
    SDK-->>AI: terminal result
    AI->>AI: schema + bounds + provenance validation
    alt valid
        AI->>Repo: atomic derivation revision
        Repo-->>UI: organized view/tasks
    else invalid, failed, or cancelled
        AI-->>UI: retryable error; source unchanged
    end
```

### 4a. AJ-RI-3 explicit-local organization (ADR-023)

```mermaid
sequenceDiagram
    participant U as User
    participant AJ as Audio Journal
    participant SDK as Packaged Hybrid AI SDK
    participant M as SDK llama.cpp Provider

    U->>AJ: choose entries + Local + consent
    AJ->>SDK: journal.organize@1 (exact contract input)
    SDK->>M: exact package/profile under lease
    M-->>SDK: buffered grammar-constrained JSON
    SDK-->>AJ: completed only after structural validation
    AJ->>AJ: resultViolation + semantic/provenance checks
    alt all checks pass
        AJ-->>U: persist and show Organized/Tasks
    else any check fails
        AJ-->>U: typed no-result state; source unchanged
    end
```

No token stream or partial JSON is persisted. `aj.rules` is not on this
production path.

## 5. Source and derivation model

```mermaid
classDiagram
    class JournalEntry {
      id
      kind
      createdAt
      status
    }
    class Recording {
      id
      relativePath
      durationMs
      state
    }
    class TranscriptSegment {
      id
      startMs
      endMs
      text
      state
    }
    class DerivedArtifact {
      id
      kind
      revision
      schemaVersion
    }
    class Task {
      id
      text
      state
      dueDate
      predecessorTaskId
    }
    class SourceReference {
      segmentId
      audioStartMs
      audioEndMs
    }

    JournalEntry "1" --> "0..1" Recording
    JournalEntry "1" --> "0..*" TranscriptSegment
    DerivedArtifact "0..*" --> "1..*" JournalEntry
    DerivedArtifact "1" --> "0..*" Task
    DerivedArtifact "1" --> "1..*" SourceReference
    Task "1" --> "1..*" SourceReference
    Task "0..*" --> "0..1" Task : carried from
    SourceReference --> JournalEntry
    SourceReference --> TranscriptSegment
```

### Task state (ADR-020)

```mermaid
stateDiagram-v2
    [*] --> open: new, ambiguous, or unproven task
    [*] --> done: carried from a done predecessor
    [*] --> dismissed: carried from a dismissed predecessor
    open --> done: Done
    open --> dismissed: Dismiss
    done --> open: Restore
    dismissed --> open: Restore
```

A task's text, due date, and predecessor never change; only its state does.
A reorganize adds a new revision and leaves earlier task rows unchanged.

## 6. App-lock state

```mermaid
stateDiagram-v2
    [*] --> UNCONFIGURED
    UNCONFIGURED --> LOCKED: create local PIN
    LOCKED --> UNLOCKING: PIN or biometric request
    UNLOCKING --> UNLOCKED: local authentication succeeds
    UNLOCKING --> LOCKED: fail/cancel/key unavailable
    UNLOCKED --> LOCKED: timeout/background/manual lock
    LOCKED --> RESET_CONFIRMATION: request local reset
    RESET_CONFIRMATION --> LOCKED: cancel
    RESET_CONFIRMATION --> UNCONFIGURED: approved destructive reset
```

## 7. Recording state

```mermaid
stateDiagram-v2
    [*] --> IDLE
    IDLE --> PREPARING: record
    PREPARING --> RECORDING: writer active
    RECORDING --> PAUSED: pause
    PAUSED --> RECORDING: resume
    RECORDING --> FINALIZING: finish
    PAUSED --> FINALIZING: finish
    FINALIZING --> READY: file finalized and row committed
    PREPARING --> FAILED: no valid source created
    RECORDING --> RECOVERABLE: interruption/process/storage failure
    PAUSED --> RECOVERABLE: interruption/process/storage failure
    FINALIZING --> RECOVERABLE: commit/finalize mismatch
    RECOVERABLE --> READY: startup reconciliation
    RECOVERABLE --> FAILED: unrecoverable after user-visible review
```

## 8. Deployment boundary

```mermaid
flowchart LR
    Repo[Audio Journal repository]
    App[Installed mobile app]
    Package[Versioned Hybrid AI package]
    Core[Hybrid AI runtime]
    Node[Private AI Node]

    Repo --> App
    Package --> App
    App -->|public API only| Core
    Core -->|paired encrypted connection| Node
```

## 9. Backup and restore sequence

```mermaid
sequenceDiagram
    actor User
    participant UI as Backup & restore UI
    participant Backup as BackupService
    participant Store as Database + recordings
    participant Picker as OS document picker

    User->>UI: Create backup
    UI->>Backup: create(strong portable secret)
    Backup->>Store: consistent snapshot + referenced files
    Store-->>Backup: bounded record/file streams
    Backup->>Backup: authenticated encrypt + finalize
    Backup->>Backup: reopen, authenticate, verify checksums
    Backup->>Picker: save verified .ajbackup
    Picker-->>User: user-controlled destination

    Note over User,Picker: Later, after app data is cleared or on an empty install

    User->>UI: Restore backup
    UI->>Picker: select .ajbackup
    Picker-->>Backup: user-selected archive
    UI->>Backup: inspect(secret)
    Backup->>Backup: authenticate + validate version/bounds/checksums
    Backup-->>UI: preview date, counts, size
    User->>UI: Confirm restore
    UI->>Backup: restore into staging vault
    Backup->>Backup: validate DB/files/provenance
    Backup->>Store: atomic activation
    Backup-->>UI: restored; re-enable biometrics and re-pair node
```
