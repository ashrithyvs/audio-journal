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
- Leaving the app locks it at once. The one exception is system UI the app
  opens itself: the microphone permission dialog or the document picker for
  a backup. Those may stay open for up to 2 minutes without locking, and then
  the app locks anyway. The privacy curtain stays on throughout (ADR-017,
  owner decision of 2026-10-10).

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

Leaving the app pauses recording and then locks the journal. Nothing captured
is lost:

- At the next unlock, the recording is saved as a normal entry, labelled
  “Recording was interrupted; everything captured up to then was saved.”
- It is transcribed like any other recording.
- Only a damaged file shows “needs attention” (ADR-017, owner decision of
  2026-10-10).

## 6. Entry detail

- Original audio playback and written source occupy the primary visual hierarchy.
- The full on-device transcript starts by itself after a recording is saved.
  Any recording still without one is queued again after each unlock, one at
  a time.
  - While a transcript is being made, the entry shows that it is in progress
    and offers Cancel.
  - After a failure, it offers Try again; failed passes are not retried
    automatically in the same session.
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

## 7.1 Private AI Node settings (implemented in AJ-3)

**Settings → Manage Private AI Node** shows:

- **Status.** A text status pill (not color alone): No node paired, Connecting
  securely…, Connected, Reconnecting…, Unavailable, Identity check failed, Trust
  revoked, or Pairing key unavailable. It names the active node, shows a short
  node ID, and offers one recovery action: Reconnect, Pair a node, or Forget and
  pair again.
- **Status after a failed request** (AJ3-REV-001/003). A request that fails on
  the link is direct evidence, so the pill changes at once; it never keeps
  saying Connected:
  - `NODE_UNAVAILABLE` shows Unavailable;
  - `NODE_AUTHENTICATION_FAILED` shows Identity check failed;
  - `NODE_TRUST_REVOKED` shows Trust revoked;
  - `CREDENTIAL_UNAVAILABLE` shows Pairing key unavailable.

  The app then makes at most one secure connection attempt, single-flight
  and debounced, so the SDK stores the real state. The request is never
  retried automatically. The status returns to Connected only after a
  later successful contact, or after an explicit recovery. Successful contact
  is a node result, a successful reconnect, or the SDK's own reconnect when
  the network returns, which needs no tap. A stale "connected" never
  counts. The Diary keeps working
  throughout.
- **Revoked or unusable trust.** The SDK deactivates a node whose trust
  failed, so there may be no active node.
  - The pill then describes that exact node, labelled "Affected node": the
    one whose failure this session saw, or, after a restart, the only stored
    node in that state. It offers one action, "Forget and pair again".
  - If several stored nodes are in that state, none is picked. The pill
    says Trust revoked, and each node's row offers its own "Forget and pair
    again".
  - "No node paired" appears only when nothing is stored. Inactive paired
    nodes show "No active node".
- **Paired nodes.** Each node shows Paired · Active, Paired, Revoked,
  Forgetting…, or Key unavailable, with Make active and Forget. A revoked or
  key-unavailable node offers "Forget and pair again" instead of Forget.
  After a forget, the screen says whether the node confirmed it. If not, it
  asks the user to also remove this device on the node.
- **Nearby nodes.** Results appear under an explicit statement that announced
  nodes are unverified and that finding one never pairs it. Every row carries
  an "Unverified" pill. Rows that claim a paired identity, conflict with
  another announcement, or reuse a node name show "Unverified · Possible
  impersonation" with an explanation. The section covers searching, empty, and
  failed states, plus permission denial (Open settings; code pairing still
  available).
- **AI routing.** "Use Private AI Node" and "Use on-device AI" switches. They
  only restrict routing; there is no cloud fallback.

**Pair a node** is a five-step flow:

1. Paste the code text shown on the node.
2. Check it. The flow shows the name carried by the code and a countdown, and
   an expired code is refused here.
3. Connect securely, with Cancel available.
4. Compare the six-digit verification code with the node's screen, with the
   node-reported name labelled "unverified". Choose "Codes match" or "Codes
   don't match".
5. Paired.

Every failure shows a title, a plain explanation, the public error code, and
"Enter a new code". Leaving the screen, or locking the app, cancels an
unfinished ceremony. Camera QR scanning is deferred (ADR-015).

**Developer diagnostics** shows:

- SDK state, node link state, policy, and capability descriptors;
- a test request with a target (auto, local, node) and a deadline (5 s or
  30 s);
- the last request's phase, request ID, events, target, routing reason,
  result validity, typed failure, and local/node reasons;
- development timings.

It never shows input or output text.

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

**Recovery key** (owner decision, 2026-10-10):

1. The app shows the 24 words.
2. It hides them, then asks for the words at three different positions,
   chosen at random (for example, “word 4, word 11, word 20”).
3. Each answer must be exactly right, in that order. A wrong answer returns
   to the word list, and the user can try again.

The answers are never logged or stored. A checkbox alone (“I wrote it down”)
is never enough. Screenshots stay blocked and the privacy curtain stays on.

**A recording that can no longer be read** (owner decision, 2026-10-10):

- Create backup stops and lists every affected entry: its date, its title,
  and what is damaged.
- Only after an explicit choice, “Back up without these entries,” does it
  continue. That choice is confirmed by typing a short word, for example
  SKIP.
- Continuing needs a typed confirmation.
- The result then says the backup is incomplete and names what was left out.
- The suggested file name ends in `-incomplete`.
- Backup history in Settings shows the backup as incomplete, by count only.
- The journal itself is not changed. Nothing is ever left out silently.
- **Limitation.** The archive file does not say that it is incomplete
  (`AJ1-DEC-001`, option B). A renamed copy looks like a full backup.

**Restore** (owner decision, 2026-10-10):

- **Empty journal.** Restore is offered only while the journal shows no
  entries and has no playable recordings.
  - Hidden leftovers do not count: discarded or failed attempts.
  - The confirmation screen counts them and says they will be removed with
    the old, empty journal.
  - The user must confirm.
- **Activating.** The user re-enters the current PIN, even though the app is
  unlocked; the normal wrong-PIN limits apply. That PIN protects the
  restored journal. Biometric unlock is turned off.
- **After activating.** The app locks at once, and the user unlocks into the
  restored journal.
- **Failure.** If restoring fails at any point, the journal is exactly as it
  was.

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
