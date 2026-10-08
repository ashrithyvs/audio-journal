# UX Design

**Status:** Frozen interaction principles and target v0.1 flows.

## 1. Experience principles

- The app feels like a calm private journal, not an AI dashboard.
- Capture is one obvious action and never waits for AI readiness.
- Recording UI shows the words being captured, not classifications or advice.
- Organization is requested, reviewable, and reversible.
- Technical routing information stays in an optional developer diagnostics view.
- Locked/background states reveal no journal content.

## 2. Information architecture

```text
Locked / onboarding
        |
        v
Journal
├── Diary timeline ── Record / Write / Search
└── Organized ─────── Work / Personal / Ideas / People / Projects
  |
Entry detail / playback
  |
Optional Organize
  |
Organized views and Tasks

Settings
├── App lock and auto-lock
├── Private AI Node
├── Storage/privacy
├── Backup & restore
└── Developer diagnostics
```

The Journal surface has two explicit peer views:

- **Diary** shows raw voice and written entries chronologically without requiring
  categorization or AI output.
- **Organized** shows optional derived sections—Work, Personal, Ideas, People,
  and Projects—without removing entries from Diary or changing their source.

Tasks remain a dedicated action view, but every derived task links back through
Organized/Entry detail to the exact source.

## 3. First launch

Copy direction:

```text
Your journal stays on your device.

Create a PIN to protect it.
No account or internet connection is required.
```

Flow:

1. Explain local-only account model and loss/recovery implications.
2. Create and confirm PIN/passcode.
3. Offer optional Face ID/Touch ID/Android biometric unlock if supported.
4. Choose the initial auto-lock setting or accept the documented default.
5. Request microphone permission only when recording is first invoked, not as a
   prerequisite for written journaling or onboarding.

## 4. Unlock

- Default to available enabled biometric prompt with a visible “Use PIN instead.”
- Never show entry titles, transcript excerpts, waveform thumbnails, task text,
  or search history behind the lock.
- Biometric cancellation returns to the locked screen rather than looping prompts.
- Biometric failure/lockout/invalidation always exposes PIN fallback.
- No “forgot PIN” email flow. A local reset action must state exactly what data
  will be lost and require deliberate confirmation.

## 5. Recording screen

```text
10:42 PM

        waveform / level

I've been working on the Hybrid AI SDK today...
and tomorrow I need to finish...

        [ Pause ]
        [ Finish ]
```

Show elapsed time, input level, provisional transcript, pause/resume, and finish.
Do not show task badges, mood labels, categories, “AI is thinking,” model names,
or node-routing decisions while the user is speaking.

If transcription becomes unavailable, keep the timer/waveform active and show a
quiet non-blocking status such as “Recording safely; transcription can resume later.”

## 6. Entry detail

- Original audio playback and written source occupy the primary visual hierarchy.
- Transcript segments synchronize with playback and expose correction controls.
- Derived summary/topics/tasks appear in a separate clearly labeled area.
- Every derived item offers “View source,” jumping to transcript and audio range.
- Reorganize creates a new derivation; it does not erase the original entry.

## 7. Diary and organized modes

Diary timeline does not visually punish unorganized entries. “Organize” is an
optional action on an entry or explicit selection/range.

The Journal header exposes a clear **Diary / Organized** switch. Organized mode
groups derived material under human-readable sections such as **Work** and
**Personal**, with Ideas, People, and Projects available when present. These are
views over the diary, never alternative storage buckets. Each organized item
shows how many source entries support it and offers a source action.

Before the first node-assisted organization, explain:

- which selected transcript content will leave the phone;
- that it goes only to the paired private node through Hybrid AI;
- that original audio stays local by default;
- that cancellation or failure will not change the source entry.

Organized results are suggestions/views. Users can edit, dismiss, or regenerate
them and can mark tasks done without changing the diary.

### Task source reference

Every task row shows a compact source label including entry date/time and the
exact audio range, for example “Oct 8 · 1:31–2:18.” Selecting it opens a source
sheet with:

- the originating diary entry and timestamp;
- the task text;
- a player already constrained to the cited audio excerpt;
- the matching transcript words highlighted;
- an action to open the full original entry.

The task cannot be persisted or displayed as AI-derived when this reference is
missing or invalid.

## 8. Offline and error UX

- Offline capture and browsing are normal states, not warnings.
- Node unavailable: “Your entry is safe on this device. Organize when your
  Private AI Node is available.”
- STT unavailable: preserve recording and show retry/transcribe-later.
- Low storage: warn early, show remaining recording risk, and finalize safely.
- Interrupted recording: foreground recovery state before any AI retry.
- Invalid AI result: show a concise retry option; never render unvalidated content.

## 9. Accessibility

- All controls have stable labels and states; record/pause/finish are not color-only.
- Support dynamic type, screen readers, reduced motion, and adequate touch targets.
- Provide transcript navigation independent of waveform gestures.
- Announce recording/transcription status changes without reading private content
  on the lock screen or through notifications.

## 10. Privacy-sensitive surfaces

- Obscure app-switcher snapshots when locked/backgrounded.
- No journal text in push notifications, widgets, crash reports, or OS shortcuts
  by default.
- Clipboard and separate human-readable data export require explicit action and
  are outside v0.1 until designed; encrypted Backup & restore is in v0.1 scope.
- Developer diagnostics use IDs, timings, targets, and error codes only.

## 11. Backup and restore

Settings shows **Backup & restore** with the last verified backup date or “No
backup yet.” It contains two explicit actions:

- **Create backup** — shows included data and estimated size, asks for a strong
  backup password or generated recovery key, then opens the OS save picker.
- **Restore backup** — intended for an empty/new journal, opens the OS file
  picker, requests the backup secret, previews counts/date/size, and confirms restore.

The create flow must say:

- this is an encrypted snapshot, not automatic sync;
- the user chooses and owns the destination;
- Audio Journal cannot recover a lost backup password/recovery key;
- new entries require a new backup;
- PIN, biometrics, and Private AI Node pairing are not included.

Progress is expressed as phases and bytes/items, never entry titles or transcript
text. On success show the verified filename, creation time, size, and destination
provider when the platform safely exposes it. On cancel/failure, state that the
existing journal is unchanged and incomplete output was removed.

Restore preview shows archive date, format version, entries, recordings, tasks,
and required/free storage. After success, prompt the user to re-enable biometrics
and re-pair the Private AI Node.
