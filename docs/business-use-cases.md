# Business Use Cases

## 1. Actors

- **Journal user:** captures and reviews their private source material.
- **Private AI Node operator:** normally the same person; pairs user-controlled compute.
- **Application developer:** builds the journal against public Hybrid AI APIs.
- **Capability developer:** maintains application-owned node contracts such as `journal.organize@1`.
- **Hybrid AI SDK maintainer:** provides product-neutral local/node execution.

## 2. Primary use cases

### UC-01: Create a raw diary entry

1. User unlocks locally.
2. User starts a voice recording or creates a written entry.
3. The app persists source material locally.
4. User finishes without selecting organization.
5. The entry appears unchanged in the diary timeline.

**Value:** private capture without forcing interpretation or categorization.

### UC-02: Record with live transcription

1. Recording begins and durable audio writing starts first.
2. Audio frames are offered to a local transcription capability.
3. Provisional timestamped text appears while the user speaks.
4. Finalized segments replace their provisional versions.
5. If STT fails, audio recording continues and the user can transcribe later.

**Value:** immediate readable feedback without risking the recording.

### UC-03: Review and correct an entry

1. User opens an entry and plays audio.
2. Playback highlights the current transcript segment.
3. User corrects transcript text if needed.
4. The correction is stored as an edit while audio remains unchanged.

**Value:** trustworthy review with the original always available.

### UC-04: Organize selected entries

1. User selects one entry or an explicit date/range.
2. The app explains that selected transcript content may be processed by the
   paired Private AI Node and asks for confirmation when appropriate.
3. Hybrid AI executes the versioned organization capability.
4. The app streams non-sensitive progress and validates the final result.
5. It saves derived sections/topics/tasks with provenance to source segments.

**Value:** useful structure without converting the diary into an AI feed.

### UC-05: Follow a task back to its source

1. User opens a derived task.
2. The app shows its originating entry and transcript excerpt.
3. User can jump to and play the cited audio time range.
4. Editing task state does not alter the diary entry.

**Value:** extracted work remains explainable and verifiable.

### UC-06: Work without a Private AI Node

1. User unlocks, records, writes, browses, searches, and plays entries offline.
2. Local transcription runs when available.
3. A node-only organization request reports that private compute is unavailable.
4. The app retains the source and allows a later retry.

**Value:** the journal is dependable rather than a thin client.

### UC-07: Pair or forget a Private AI Node

1. User opens settings and starts SDK-provided discovery/pairing.
2. User scans and confirms the node according to the SDK security flow.
3. The app displays paired status without exposing keys or secrets.
4. User may forget the node; local journal content remains unaffected.

**Value:** optional user-controlled heavy AI without cloud identity.

### UC-08: Unlock locally

1. The app opens locked and shows no protected journal content.
2. User authenticates with the local PIN/passcode or enabled platform biometric.
3. The OS evaluates biometrics and returns only success/failure.
4. On biometric failure or invalidation, the user enters the PIN/passcode.
5. Unlock succeeds without network, SDK initialization, or node availability.

**Value:** private offline access without an account provider.

### UC-09: Recover safely from interruption

1. An audio interruption, process death, low storage condition, or AI error occurs.
2. The recording service finalizes or identifies the recoverable partial file.
3. Startup reconciliation matches files and database records.
4. The app presents recovered source material before attempting derived work.

**Value:** irreplaceable personal capture is prioritized over convenience features.

### UC-10: Back up and restore the journal

1. User opens Backup & restore and creates a full backup.
2. User protects it with a strong backup password or generated recovery key.
3. The app creates and verifies an encrypted archive, then the operating system
   lets the user save it to a destination they control.
4. After app data is cleared or the app is reinstalled, the user creates a new
   local PIN, selects the archive, and supplies its backup secret.
5. The app authenticates and previews the archive, restores it into staging,
   verifies it, then atomically activates the recovered journal.
6. The user re-enables biometrics and re-pairs their Private AI Node.

**Value:** accidental local-data loss is recoverable without an Audio Journal account.

## 3. Business rules

| ID | Rule |
|---|---|
| BR-01 | Original audio or written text outranks transcripts and derived artifacts. |
| BR-02 | Diary entries never require AI processing. |
| BR-03 | Organized mode requires explicit user selection/action. |
| BR-04 | Every derived item retains source provenance; each voice-derived task cites and can play the exact recording range where it was formed. |
| BR-05 | No account, public cloud, or public relay is required or used in v0.1. |
| BR-06 | PIN/passcode is the local fallback; biometrics are convenience only. |
| BR-07 | Recording success is independent from STT and organization success. |
| BR-08 | The app owns domain data; Hybrid AI owns capability execution/routing. |
| BR-09 | The app never imports Hybrid AI private source or headers. |
| BR-10 | Forgetting a node never deletes local journal content. |
| BR-11 | A successful backup is portable, encrypted, user-controlled, and verified; device-bound credentials are never included. |

## 4. Success measures

- Completed recordings recover correctly after restart and interruption.
- Percentage of finalized transcript segments with valid timestamps/provenance.
- Time from record tap to durable capture start and first provisional text.
- Crash-free long recording sessions and bounded memory growth.
- Organization completion/cancellation rate without source-data mutation.
- Time to navigate from a derived task to its cited source audio.
- Zero journal-content fields in logs/analytics and zero public-cloud traffic.
- Offline completion rate for unlock, capture, playback, and browsing.
