# AJ-2 Progress Validation

**Date:** 2026-10-11, amended 2026-10-12 (AJ-2.2, §9)
**Branch:** `aj2/organize` (worktree `../audio-journal-aj2`), from `main`
`c5fb510`. Not merged, not pushed, not released.

**Status:** AJ-2.0 (the `journal.organize@1` contract) and AJ-2.1 (the node
companion and the minimum app integration through the public SDK) are
**accepted by the owner as completed development checkpoints**
(2026-10-11). This is not AJ-2 acceptance, and there is no merge.

The owner's amendments before AJ-2.2 are done (§8):

- the explicit partial-result contract (amendment A1);
- cited-source navigation;
- a real voice-entry journey;
- the corrected performance wording and labels;
- SDK-AJ-5 recorded as a blocker.

AJ-2 is **not accepted**:

- final cancellation acceptance is blocked by SDK-AJ-5 until a fixed
  packaged SDK is re-tested;
- AJ-2.2 (Organized and Tasks, after the owner's approval of O-1 to O-3
  with amendments) is implemented and validated on emulators (§9), but not
  accepted;
- O-4 to O-6, and the chunking part of O-7, stay deferred;
- the physical-device and iOS gates are deferred, not passed.

## 1. Commits

| Commit | Content |
|---|---|
| `58d1587` | Contract frozen: `docs/journal-organize.md`, ADR-019, synchronized design documents |
| `9c6d3d4` | Envelope-inclusive 61,440-byte budget, opaque HMAC retry key, TLS profile |
| `8e3695a` | Schemas, deterministic vectors (`--check`), independent Python verifier |
| `d0e5fe2` | `node-companion/`: protocol, pairing, TLS profile, `aj.rules` engine, tests |
| `0b064f8` | App integration through the public SDK, migration 3, minimal UI, tests |
| `c33a2f1` | Companion: pairing trust persisted only after both sides accept (§6), count-only job logs, test-only result padding |
| `491dfd9` | Organize performance suite (developer benchmark, fixtures, harness), device harnesses, companion counters, SDK-AJ-4/5, O-7 |
| `05166b2` | Device evidence, these reports, coordination; the harness keyboard fix for API 26 |
| `b4aea98` | Amendment A1: explicit partial results (contract, ADR-019, schemas, vectors, verifier, companion, app, UI disclosure); the benchmark's `rehearsed` outcome |
| `ad430fc` | Cited-source navigation; the `e2e` build type and voice journey; SDK-AJ-5 blocker and re-test readiness; wording and labels |
| `cc763bd` | The `e2e` build creates its test input directory as the app |
| this commit | Amended device evidence (functional, performance, voice journey), these reports, coordination |

## 2. Frozen and proposed decisions

**Frozen (ADR-019, `journal-organize.md`):**

- the capability `journal.organize` `1.0.0`, node only, 60 s;
- input and output schemas, partial deltas, validation order (§6, §6.1);
- provenance: every item cites 1–8 exact sources, with voice audio ranges;
- the 61,440-byte message budget including the envelope, so
  `maximumInputBytes` is 61,108 and the output cap is 61,387;
- the opaque request key (§9);
- the TLS profile (§10);
- persistence (§7);
- amendment A1 (owner decision on O-7, 2026-10-11): a result that leaves out
  lower-ranked items is explicitly `partial`, with per-kind `omitted`
  counts. It is validated by `RESULT_COMPLETENESS` and disclosed in the UI;
  nothing is dropped silently, and there is no chunk-and-merge in v1;
- amendment A2 (owner decision on O-1, 2026-10-12): explicit English due
  dates, re-derived by the app (`RESULT_DUE`);
- ADR-020 (owner decisions on O-2 and O-3, 2026-10-12): history per
  canonical selection, computed staleness, task states, and conservative
  carry-over.

**Proposed, not frozen:** the open questions O-4 to O-6, and the chunking
part of O-7, in §12 (retention, backups, diagnostics on the companion, and
entries too long for one request). They block only the stages named there.

**Implementation choices recorded in the LLD (§7.2), not contract
changes:**

- refusal reasons, including `UNSENDABLE_TEXT` for written text with
  characters §6 forbids, so content is never rewritten;
- an `organize_secret` table, kept out of `app_settings` and backups;
- one organize at a time.

## 3. Schemas and vectors

| Artifact | Count |
|---|---|
| Fixtures | 8, one exactly at the 61,108-byte input cap, and (A2) one dated |
| Input cases | 38 (8 valid) |
| Result cases | 93 (11 valid): exactly at the 61,387-byte output cap, one byte over, and (amendment A1) partial results, including one at the cap, plus 9 completeness cases; (A2) 14 due-date cases |
| Due-date cases (A2) | 68 (40 valid), each with a literal expected date or rejection |
| Event sequences | 12 |
| Whole-message envelopes | 4: request and completed event, each at 61,440 bytes and one byte over |
| Request keys | 7, under a published test key |

Four independent checks pass on these artifacts:

- `generate-vectors.mjs --check` rebuilds every file byte for byte;
- the Python verifier reports 0 failures;
- Ajv 6 compiles the schemas and accepts every valid case;
- the app's TypeScript validator reaches every verdict and sub-code
  (`unit-tests/organizeContract.test.ts`).

The app's request builder rebuilds all 8 fixtures byte for byte from journal
entries, including the one at the input cap
(`unit-tests/organizeController.test.ts`).

## 4. Host validation

| Suite | Command | Result |
|---|---|---|
| Vectors | `node tools/journal-organize/generate-vectors.mjs --check` | unchanged |
| Independent verifier | `python3 -I tools/journal-organize/verify_vectors.py schemas/journal/v1` | 0 failures |
| Companion | `cd node-companion && npm test` | 36/36 |
| Engine golden | `node scripts/engine-golden.mjs --check` | 7 fixtures unchanged |
| Contract copies | `npm run check-contract` | 0 problems |
| App baseline | `npm run test:baseline` | format, typecheck, lint; unit 287, smoke 3, integration 142, performance 6 |
| JVM | `./gradlew :app:testDebugUnitTest` | 61/61, including the native digest known answers |
| Builds | `./gradlew :app:assembleDebug :app:assembleRelease` | both pass (release rebuilt on `491dfd9`) |

**Companion load baseline** (`node scripts/load.mjs`, 4 paired devices, 8
concurrent, 200 jobs each run, 0 failures):

| Fixture | Input | p50 | p99 | Throughput | RSS peak |
|---|---|---|---|---|---|
| `max` | 61,108 bytes | 118 ms | 171 ms | 65.7 jobs/s | 222 MB |
| `mixed` | 3,104 bytes | 46 ms | 76 ms | 167.4 jobs/s | 147 MB |

This is a host development baseline on final companion code `491dfd9`
(`aj1-artifacts/evidence/aj2-companion/load-20261011-final.log`). It
matches the first run on `d0e5fe2` (122 ms and 46 ms p50).

**TLS profile on the host** (`test/tls.test.mjs`):

- TLS 1.3 is accepted;
- TLS 1.2 is accepted with each of the three ECDHE-ECDSA AEAD suites, with
  EMS;
- TLS 1.2 without EMS is refused;
- RSA-only suites fail the handshake;
- TLS 1.1 is refused.

## 5. Device validation

The final APK is `491dfd9`: a release build, `app-release-aj2-491dfd9.apk`,
SHA-256 `8a22bb0535a4de15175e384df30c154ceb7e7548bd1ab057bd224fd985cd6258`.
It uses the packaged SDK `0.1.0-m5` (`e0fc3c5`), unchanged. Evidence is in
`aj1-artifacts/evidence/aj2-device/`, outside the repository. Screenshots
are blocked by `FLAG_SECURE`, so the evidence is UI-hierarchy text,
companion counts, and the device log.

### 5.1 Functional suite (`e2e/aj2/organize-e2e.mjs`, API 35)

**On the amended build (A1):** run 4 (`api35-run4/`) passed **9/9** on
`ad430fc` (`app-release-aj2-ad430fc.apk`, SHA-256 `f3e9fa0e…3472`). O03
again recorded SDK-AJ-5. The run-3 detail below, on `491dfd9`, is kept.

Run 3 passed **9/9** on emulator `aj-api35-4g` (`api35-run3/`). All steps
go through the real app UI, the packaged SDK, and the companion:

| Step | Result | Evidence |
|---|---|---|
| O00 install, PIN, pairing | pass | The codes on the phone and at the companion matched; one pairing record. |
| O01 consent | pass | The consent names the node and says text only. Declining sends nothing (no job at the node). Confirming stores the result; summary and tasks are shown. |
| O02 identical retry | pass | Recognised as already organized; no new job at the node. |
| O03 cancel | pass | The app shows Cancelled and stores nothing. The node job still completed about 46 s later: SDK-AJ-5, recorded, not hidden. |
| O04 node down, then back | pass | Down: failed and stored nothing. Back: stored, and the status shows Connected without a tap (the F5 hooks via `reportNodeRun`). |
| O05 deadline | pass | A node slower than 60 s fails with a deadline error; nothing stored. |
| O06 boundary | pass | A 60,045-byte request. The SDK accepted a completed message of exactly **61,440 bytes** (sequence 10; output exactly 61,387 bytes) in one frame. A 61,000-character entry is refused as too long, and nothing is sent. |
| O07 load | pass | 5 sequential runs, all stored. |
| O08 privacy | pass | The device log and every companion log hold none of the marker words from the entries, titles, or results. The companion logged only `handshake` and `job-ended` events. Every handshake was TLS 1.3 (`TLS_AES_256_GCM_SHA384`). |

Runs 1 and 2 (`api35-run1/`, `api35-run2/`) failed only on harness
defects, all fixed:

- the Diary tab navigation;
- flinging to the panel past a 58 KB entry;
- the envelope size of a one-digit sequence;
- the timing of the node-side cancel check.

They led to SDK-AJ-5 (§6). Their app-side steps passed.

### 5.2 Organize performance suite (API 35)

These figures are the deterministic `aj.rules` baseline: protocol and SDK
overhead, not model-backed inference or organization quality.

See the [organize performance suite](AJ2-organize-performance.md#5-results).
In summary:

This was the current run for the A1 amendments: `perf-api35-run2` on the
amended build `ad430fc`. The cumulative AJ-2.2 rerun, `perf-api35-run3`,
supersedes it (§9).

- all 126 organize runs completed and were validated, with persistence
  rehearsed in rolled-back transactions; none was committed (the stored
  derivations are the functional cases in §5.1 and the voice journey in
  §5.4);
- warm completion is 40–52 ms p50 from 30 s to 10 min of speech, and
  137 ms p50 at the exact 61,108-byte cap;
- the result is on screen at 65–222 ms p50;
- results for 30 s – 5 min were complete. Every 10-minute result was
  explicitly partial, with 3 items omitted, and every result at the cap
  with 155 omitted (amendment A1; before A1 these were dropped silently);
- the typed refusals sent nothing;
- the SDK rejected cap + 1 with `SCHEMA_VALIDATION_FAILED`;
- the deadline ended 2.6 ms after 60 s;
- the cancel took 93 ms app-side, but did not reach the node (SDK-AJ-5).

These are development baselines.

### 5.3 TLS profile on API 26 and 28 (`e2e/aj2/tls-profile.mjs`)

The real app and the packaged SDK ran on new AVDs, `aj-api26` and
`aj-api28` (x86_64 default images). They paired with the companion through
the UI and organized one entry. The companion recorded every handshake.

| API | Paired | Organized | Handshakes | Protocol and suite | EMS | Accepted |
|---|---|---|---|---|---|---|
| 26 (`tls-api26-run2/`) | yes | stored | 7 | TLS 1.2, `TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256` | yes, all | 7/7 |
| 28 (`tls-api28-run2/`) | yes | stored | 7 | TLS 1.2, `TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256` | yes, all | 7/7 |
| 35 (§5.1, O08) | yes | stored | all | TLS 1.3, `TLS_AES_256_GCM_SHA384` | n/a | all |

This proves the frozen Android support profile against the companion with
the packaged SDK, as SDK ADR-022 Q2 requires: TLS 1.3 on API 29 and later,
and on API 26–28 restricted TLS 1.2 ECDHE-ECDSA AEAD with Extended Master
Secret. The Android floor was not raised. The refusal side (TLS 1.2
without EMS, RSA suites, TLS 1.1) is proven on the host (§4).

The first attempts failed only in the harness:

- API 26: the keyboard key acted as Back (§6);
- API 28: the clipboard helper was not installed, and the check used the
  OpenSSL suite names.

Even so, the API 28 attempt had already paired over the same TLS 1.2 + EMS
profile (`tls-api28/`).

### 5.4 Real voice-entry journey (`e2e/aj2/voice-journey.mjs`, API 35)

Run 4 (`voice-api35-run4/`) passed **7/7** on the `e2e` build `cc763bd`
(`app-e2e-aj2-cc763bd.apk`, SHA-256 `b4532186…901c`). The `e2e` build is
release-like with the JS bundled, and adds one thing: the next capture reads
a pushed WAV instead of the emulator's silent microphone. The release APK
contains none of that code; its `TestAudioInput` is a stub.

| Step | Result | Evidence |
|---|---|---|
| V00 install, PIN, companion, pairing | pass | The sample is whisper.cpp's `jfk.wav` with the AJ-1 speech harness's pinned SHA-256, from the speech engine's source tree; no audio is committed. |
| V01 capture through the app | pass | Diary → Record → Finish; a 15 s recording (the 11 s sample, then silence), sealed into AJR1 by the production capture path. The capture consumed the input. |
| V02 on-device final pass | pass | whisper.cpp's final pass made the transcript "And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country." (0:00). |
| V03 organize | pass | The consent says text only. The request went through the public SDK to the companion; the app validated the result (§6, including the voice audio ranges) and stored it. The summary cites "Source · 0:00–0:11". |
| V04 open the cited source | pass | The organized item opens the entry at the cited source. The range and excerpt are shown, and the cited transcript line (0:00, the sentence above) is highlighted. The range starts at that line's segment start, and the excerpt is in that line. |
| V05 play the cited range | pass | "Play this part" played positions 0, 1, 4, 5, 7, 8, 10 s, all inside 0–11 s, then "Played". |
| V06 privacy | pass | Neither the device log nor the companion log holds "fellow americans" or "your country". |

Runs 1–3 failed only in the harness, and each failure was fixed:

- run 1: the input directory was made by `adb shell`, so the app could not
  read it (fixed in `cc763bd`);
- run 2: the link label is a child Text node;
- run 3: the cited line's timestamp was read by bounds.

Their app-side steps passed. Run 2 already showed the same transcript and
the "Source · 0:00–0:11" citation.

## 6. Findings

- **Companion pairing persistence (fixed, `c33a2f1`).** ADR-022 step 5
  persists trust "only after both accept". The companion recorded a pairing
  as soon as the operator approved. So an operator approval followed by the
  device's reject left a trusted record for a device that had declined. It
  now commits only when both have accepted, in either order. A protocol test
  covers all three orders. It was found while writing the device suite, not
  in the field.
- **SDK documentation gap (SDK-AJ-4).** The published node protocol does not
  fix the HTTP status of job creation and replay, or response framing. See
  [the SDK findings](hybrid-ai-sdk-issues.md#sdk-aj-4-the-node-protocol-leaves-job-creation-status-and-framing-undocumented).
- **SDK defect SDK-AJ-5 (new).** A cancel that arrives while the SDK waits
  for the next event never sends `DELETE /v1/jobs/{id}`, so the node runs
  the job to completion. `NodeClient::stream` returns from its
  cancellation-aware receive without calling `cancel(job_id)`. It is
  reproduced in O03 and in the performance suite's cancel block (0 of 5
  jobs cancelled at the node). The app is unaffected and stores nothing;
  there is no workaround through the public API. See
  [the SDK findings](hybrid-ai-sdk-issues.md#sdk-aj-5-a-cancel-during-a-pending-event-read-is-not-sent-to-the-node).
- **Output budget (O-7).** From about 10 minutes of speech, the engine's
  full result exceeds the 61,387-byte output cap, and it drops items to
  fit. About 26.5 minutes of speech fills the 61,108-byte input cap; 30 and
  60 minutes are refused with typed reasons. See the
  [performance suite](AJ2-organize-performance.md#6-findings-and-open-questions).
- **Harness, API 26.** On the API 26 image, `KEYCODE_ESCAPE` with no
  keyboard shown acts as Back and leaves the app. The shared
  `hideKeyboard()` now sends it only while an input method is shown. On
  API 35 the behaviour is unchanged.
- **SDK-AJ-1 and SDK-AJ-2** (revocation persistence, status after request
  failures) still stand. Their root cause is recorded in the SDK findings.
  Audio Journal keeps its tested app-side compatibility workaround
  (`57f316c`, UX §7.1), and organize runs feed the same hooks
  (`reportNodeRun`).

## 7. Deferred gates

- Physical-device runs. Only emulators were used.
- iOS: no macOS/Xcode evidence.
- Cancellation acceptance: blocked by SDK-AJ-5 until a fixed packaged SDK
  passes the re-test (`--expect-node-cancel`).
- The voice journey uses a recorded sample instead of a live microphone.
  Live-microphone capture on a physical device belongs to the
  physical-device gates.

## 8. Owner amendments before AJ-2.2 (2026-10-11)

| # | Requirement | Done | Evidence |
|---|---|---|---|
| 1 | Label the performance results as the deterministic `aj.rules` baseline; keep it as the protocol and SDK overhead baseline | done | [Performance suite](AJ2-organize-performance.md), "Labels"; a model-backed engine needs its own baseline |
| 2 | Resolve O-7's lossy output with an explicit partial result, disclosed in the UI, with no silent drops and no chunk-and-merge | done | Amendment A1 (contract §3.2, ADR-019, `RESULT_COMPLETENESS`). It is consistent across the schemas, the 79 result vectors, the Python verifier, Ajv, the companion engine and validator, the app validator, the UI (`organize-partial`), UX §7, and the performance rerun (10 min and the cap are explicitly partial) |
| 3 | SDK-AJ-5 is a blocker for cancellation acceptance, handed to the SDK owner; the SDK stays read only | done; **blocker open** | [SDK-AJ-5](hybrid-ai-sdk-issues.md#sdk-aj-5-a-cancel-during-a-pending-event-read-is-not-sent-to-the-node): root cause, reproduction, and the re-test (`--expect-node-cancel`). Node-side readiness is proven on the host (protocol test "a cancelled job keeps no result") |
| 4 | A real voice-entry device journey through to the cited audio range | done | §5.4: 7/7 on `cc763bd`. It covers capture, the on-device final pass, organize through the public SDK, provenance validation, persistence, the cited line, and playback of the exact range. The synthetic duration ladder stays in the performance suite |
| 5 | The performance runs are rehearsed (rolled-back) persistence, not committed derivations | done | The benchmark's outcome is `rehearsed`; the reports are reworded. The committed storage evidence is §5.1 and §5.4 |

## 9. AJ-2.2: Organized and Tasks (2026-10-12)

The owner approved O-1, O-2, and O-3 with amendments (2026-10-12). AJ-2.2
is implemented on `aj2/organize`. It is not merged, pushed, released, or
accepted.

**Decisions** (permanent records):

- O-1, due dates: contract §3.3 and amendment A2 (ADR-019);
- O-2, history and staleness: ADR-020;
- O-3, task states and carry-over: ADR-020.

| Commit | Content |
|---|---|
| `c0edd93` | Amendment A2 and ADR-020: due-date grammar, schemas, vectors (68 literal due-date cases), Python verifier, companion engine and validator, app validator |
| `10ced20` | Migration 4 (due date, predecessor, immutability trigger), canonical scope, computed staleness, conservative carry-over, repository queries, lineage tests |
| `d865385` | Organized, History, and Tasks views; source labels with the entry's moment; the edited-source view; UX §7, LLD §7.3, HLD, UML, roadmap |
| this commit | The Organized and Tasks device journey, shared voice helpers, evidence, these reports, coordination |

**Required cases, and where each is tested:**

| Case | Test |
|---|---|
| Due-date vectors (boundary, leap year, month end, time-zone crossing, rejected phrases) | `vectors/due-dates.json`: the Python verifier, the companion (`test/dates.test.mjs`), and the app (`unit-tests/organizeContract.test.ts`) agree on all 68 |
| A date the app cannot reproduce is rejected | result vectors `due-*`, including `due-tz-crossing-utc-date` (`RESULT_DUE`) |
| Canonical selection identity (reordered, repeated) | `unit-tests/organizeViews.test.ts`, `organizeRequest.test.ts`, `integration-tests/organizeLineage.test.tsx` |
| Duplicate task, corrected line, re-transcription, changed written text, reordered output | `unit-tests/organizeCarryOver.test.ts` (7), `integration-tests/organizeLineage.test.tsx` (6) on SQLite |
| Stale marks, the cited source as cited and as now, explicit Reorganize with consent, history, carried state | `integration-tests/organizedTasks.test.tsx` (3) and the device journey below |
| Due-date groups and Done, Dismiss, and Restore | `integration-tests/organizedTasks.test.tsx`, `unit-tests/organizeViews.test.ts`, and the device journey |

**Host validation (`d865385`):**

| Suite | Result |
|---|---|
| `npm run test:baseline` | format, typecheck, lint; unit 308, smoke 3, integration 153, performance 6 |
| Companion `npm test` | 42/42 |
| Vectors `--check`, Python verifier | 8 fixtures, 38 input, 93 result, 68 due-date cases; 0 mismatches, 0 failures |
| Engine golden, contract copies | 8 fixtures unchanged; 0 problems |
| JVM `:app:testDebugUnitTest` | 61/61 |
| Builds | release and `e2e` pass; archived in `aj2-device/apk-d865385/` with SHA-256 |

**Organized and Tasks device journey** (`e2e/aj2/organized-tasks.mjs`,
API 35 emulator, `e2e` build, run 4: **11/11**). The emulator's zone is
Asia/Kolkata. The entry was saved at about 02:12 IST on Monday 12 October,
which is 20:42 UTC on 11 October, so the run crosses the UTC date line.

| Step | Proves |
|---|---|
| T01 | The companion's engine dates four tasks. The app's validator re-derives each date on Hermes and stores the result (a disagreement would be `RESULT_DUE`). The host derives the same dates independently: today 2026-10-12 (not the UTC date), tomorrow 2026-10-13, "by Friday" 2026-10-16, "14 November" 2026-11-14 |
| T02 | Tasks groups them as Today, Upcoming (in date order), and No date, with labels "Due today" and "Due Tue 13 Oct 2026" |
| T03 | Done, Restore, Dismiss, and Restore move rows between groups |
| T04 | A task's source reads "Source · Oct 12, 2:12 AM · paragraph 3" and opens the cited sentence |
| T05–T06 | A recorded voice entry, with its first line corrected, is organized; its task is marked done |
| T07 | A second correction marks the result and the task stale, without hiding either. The source opens as cited ("I need to call the plumber.") and as it reads now ("So I need to call the plumber.") |
| T08 | Reorganize sends nothing before consent. After it, revision 2 is current and not stale, and the task stays done, "kept from earlier" |
| T09 | History lists both revisions; revision 1 stays marked stale |
| T10 | No entry phrase in the device log or the companion log |

Runs 1 to 3 failed on harness defects, which are now fixed; the app was
unchanged across all four runs:

- run 1: the Diary tab reopened on the last entry, not the timeline;
- run 2: a card heading "Tasks" was tapped instead of the tab;
- run 3: the privacy scan matched the word "rent" inside system identifiers
  such as `currentUser`. Both logs contained none of the entry's phrases;
  the scan now looks for whole phrases.

**Cumulative suites on the AJ-2.2 builds** (API 35 emulator `aj-api35-4g`,
run one after another under `.aj-exclusive-run`; APKs from `d865385`):

| Suite | Build | Result | Notes |
|---|---|---|---|
| Functional `organize-e2e.mjs` O00–O08 (`functional-aj22-api35/`) | release | **9/9** | O03: nothing stored, but the node finished the job 45.8 s after the cancel (SDK-AJ-5, unchanged SDK). O06: a 60,045-byte request and a completed message of exactly 61,440 bytes. O07: 5 runs, p50 4,334 ms. O08: logs clean, every handshake on the profile |
| Voice journey `voice-journey.mjs` V00–V06 (`voice-aj22-api35/`) | `e2e` | **7/7** | Uses the shared `lib/voice.mjs` helpers |
| Organized and Tasks `organized-tasks.mjs` T00–T10 (`organized-api35-run4/`) | `e2e` | **11/11** | Above |
| AJ-3 regression `e2e/android/aj3-e2e.mjs` S00–S19 (`aj3-regression-d865385/`) | release | **20/20** | One fresh, non-resumed run (attempt 1), 02:50–03:32 IST, APK SHA-256 `98ac7e4b…58eb`, against the SDK repository's reference node (read only), with `--expect-persistent-pin`. S19: logs clean |
| Performance `organize-perf.mjs` (`perf-api35-run3/`) | release | **complete** | 126/126 measured runs validated and rehearsed (42 explicitly partial); 20/20 typed refusals and rejections; 5/5 cancelled app-side, none at the node (SDK-AJ-5); 3/3 deadlines. Warm completion 41–55 ms p50 from 30 s to 10 min, 160 ms at the cap. A2 dates one fixture sentence, so 10 minutes now omits 4 items, not 3 ([performance §5](AJ2-organize-performance.md#5-results)) |

**Harness changes in this stage** (test code only; the app is unchanged):

- `e2e/aj2/organized-tasks.mjs` is new.
- `e2e/aj2/lib/voice.mjs` holds the pinned sample, capture, and
  child-text helpers. The voice journey now uses it, and passed 7/7 after
  the move.
- `e2e/android/aj3-e2e.mjs`: `openDiagnostics` scrolls to the request card
  and back to the top. AJ-2.1 (`491dfd9`) added the Organize benchmark
  card above it, which put the card below the fold, so the unscrolled wait
  failed at S02 on the first attempt (`aj3-regression-d865385-attempt1-s02-fold/`).
  An attempt before that stopped before S00 because the NSD fixture APK is
  built only in the main checkout; the runs pass it with `--fixture`.

**SDK-AJ-5 and cancellation acceptance.** SDK-AJ-5 still blocks final AJ-2
cancellation acceptance:

- the closing test, `organize-e2e.mjs --only O00,O03 --expect-node-cancel`,
  is prepared but cannot pass until a fixed packaged SDK is installed;
- on this build, O03 and the performance suite's cancel block reproduce
  the defect again;
- the companion's own `DELETE` handling is proven by direct calls to the
  companion ("a cancelled job keeps no result"). That proves the companion
  only; it does not close the SDK defect.

**Not done here:** physical-device and iOS runs (deferred gates); O-4 to
O-6 and the chunking part of O-7 (deferred by the owner).

## 10. SDK-AJ-5 candidate and the AJ-2 closing baseline (2026-10-12)

The app now pins the SDK-AJ-5 candidate built from SDK `c4b302e`, on the
unmerged SDK branch `fix/sdk-aj-5-node-cancel` (ADR-015 amendment):

- RN tarball `a11cba67036d6e38662e6485c75d891dfc0110ebc41cd05aa7ea8f870c14ee2a`;
- AAR `8751a5a7623a2c6ea5a75216afd410d9483410da3c9f96f4c4527c852da86b1a`.

Both hashes were verified against the SDK handoff before use. The AJ-2
closing baseline then ran on the API 35 emulator `aj-api35-4g`, with
second-slot runs on `aj-api35-4g-b`, `aj-api26`, and `aj-api28`. Evidence is
in `aj1-artifacts/evidence/aj2-sdkaj5/`, outside the repository.

**No reference to the previous artifact remains in the build inputs.**

- `package.json`, `package-lock.json` (`resolved` and `integrity`),
  `android/gradle.properties` (AAR path and SHA-256), and the pin test name
  only `c4b302e`.
- The installed package is byte-identical to the tarball (13 files).
- **APK proof.** Both APKs contain the candidate's `libhybrid_ai_core.so` for
  both ABIs, byte-identical to the `c4b302e` AAR and different from
  `e0fc3c5`:

  | APK | SHA-256 |
  |---|---|
  | release | `22c0f35d422399cd9eb6595dd9b4274031ce9928263b718cf5b08a0f8506e015` |
  | `e2e` | `5ca03fc10e5f65a57fd79ae99bf290df862ca8ee5889b5b53503068ed7576c72` |

- **What changed in the packages.** In the AAR, only `libhybrid_ai_core.so`
  changed (17 of 19 files are identical). The tarball's runtime sources are
  unchanged.
- **History.** `e0fc3c5` is still named only in records of runs that used it:
  AJ-1, AJ-3, the AJ-2.1 runs, the speech and load baseline, and the SDK
  findings' "Affected" lines. Those records stay attributed to it.

**Closing-baseline changes (test and evidence only):**

- **Companion.** The companion logs each device DELETE as a count-only
  `job-cancel-request`.
- **Developer benchmark.** The benchmark records the gateway's terminal-event
  count per run.
- **Strict closing checks.** `--expect-node-cancel` in `organize-e2e.mjs`
  (O03) and `organize-perf.mjs` (the cancel block) now requires:
  - one cancellation at the companion;
  - the node job ends `cancelled`;
  - no retained result;
  - one terminal per run;
  - a recomputed, stored retry.
- **O06.** O06 waits and scrolls for the refusal reason instead of reading
  one snapshot.
- **Privacy scan.** `e2e/aj2/privacy-scan.mjs` scans every log of a run.

| # | Suite | Result | Evidence |
|---|---|---|---|
| 1 | JS baseline (`npm run test:baseline`): format, typecheck, zero-warning lint, unit, smoke, integration, performance | **Pass** on AC power: unit 308, smoke 3, integration 153, performance 6. An earlier attempt on battery failed the timing test `privateNodeRecovery`, which also failed on the unmodified `5d9ce93` on battery | `js-baseline.log` |
| 2 | Android JVM tests; release and `e2e` builds | 61/61; both build | `apk/` |
| 3 | SDK-AJ-5 closing test, `organize-e2e.mjs --only O00,O03 --expect-node-cancel` | **2/2**. One `Cancelled` in the app; nothing shown or stored. The companion received 1 cancellation, and the node job ended `cancelled` (DELETE and end logged 1 ms apart; within 11.8 s of the tap, harness bound). `replays` unchanged. The identical retry was recomputed (`engineMs` 9) and `stored` | `closing-o03/` |
| 4 | Performance cancel block, `--only cancel --expect-node-cancel` | 5/5 cancelled in the app, 1 terminal each; 5 DELETEs; 5 node jobs `cancelled`; 0 retained | `closing-perf-cancel/` |
| 5 | Full functional suite, `organize-e2e.mjs --expect-node-cancel` | **9/9** (run 2, `aj-api35-4g-b`). O03 strict as in row 3 (10.4 s bound). O06: a 60,045-byte request and an exact 61,440-byte completed message. O07: p50 4,614 ms. O08: logs clean, and every handshake on the profile. Run 1 (`aj-api35-4g`) was 8/9: O06's refusal-text check ran while the host was on battery (about 1.05 GHz) and read the screen before the reason was drawn. The outcome was correctly `refused`, and O06 passed alone on AC (`functional-o06-rerun/`) | `functional-run2/`, `functional/` |
| 6 | Real voice-entry journey | **7/7** | `voice/` |
| 7 | Organized, History, and Tasks journey | **11/11** | `organized/` |
| 8 | Full performance matrix, deterministic `aj.rules` baseline, `--expect-node-cancel` | Complete. 126/126 measured runs validated and rehearsed (42 explicitly partial); 20/20 typed refusals and rejections; cancel 5/5 at both ends; 3/3 deadlines. See [performance §5](AJ2-organize-performance.md#5-results) | `perf/` |
| 9 | Fresh AJ-3 S00–S19 (`e2e/android/aj3-e2e.mjs --expect-persistent-pin`, SDK reference node at `984412f`, read only) | **20/20**, attempt 1, not resumed, 15:55–16:38 IST, release APK `22c0f35d…`. S19: logs clean | `aj3/` |
| 10 | API 26 and API 28 paired organize smoke (`tls-profile.mjs`) | Both paired, organized, and `stored`. 7/7 handshakes each, all TLS 1.2 `TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256` with EMS, all accepted and on the profile | `tls-api26/`, `tls-api28/` |
| 11 | Privacy and log scan over the complete run (`e2e/aj2/privacy-scan.mjs`) | **0 findings** in 54 logs (39.5 MB): 19 journal phrases from every suite, the test PIN, pairing payloads, and private keys. The scan covers the continuous API 35 logcat (until AJ-3 restarted `adbd` at 16:18), AJ-3's own logcat, every suite's device log, and every companion log. A planted control log was caught. The API 26 and 28 smokes kept companion logs only | `privacy-scan.json` |

**Result.** Every item on the AJ-2 Android-first closing list passed on
emulators. SDK-AJ-5 is closed in the real Audio Journal path
([SDK findings](hybrid-ai-sdk-issues.md#sdk-aj-5-closing-evidence-2026-10-12)).
The branch is ready for independent review and an Android-first AJ-2
acceptance decision. AJ-2 is **not accepted**. It is not merged, pushed, or
released. What remains before a merge into `main`:

1. The SDK branch `fix/sdk-aj-5-node-cancel` must receive its acceptance and
   merge commit. If the merged packages differ from `c4b302e`, the pin moves
   and the affected suites are re-run.
2. Independent review, then the owner's acceptance decision.
3. These stay deferred and are not passed:
   - physical-device runs and the physical-device performance matrix (AJ-4);
   - iOS;
   - O-4 to O-6, and the chunking part of O-7.

