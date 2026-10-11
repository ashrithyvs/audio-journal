# AJ-2 Progress Validation

**Date:** 2026-10-11
**Branch:** `aj2/organize` (worktree `../audio-journal-aj2`), from `main`
`c5fb510`. Not merged, not pushed, not released.

**Status:** AJ-2.0 (the `journal.organize@1` contract) and AJ-2.1 (the node
companion and the minimum app integration through the public SDK) are
implemented. They are validated on the host, on the Android emulator, and
for the TLS profile on API 26 and 28 emulators (§5), and the organize
performance suite has a development baseline. AJ-2 is **not accepted**:

- the full Organized and Tasks UI is the next stage and has not started;
- open questions O-1 to O-7 (`journal-organize.md` §12) are not decided;
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
| this commit | Device evidence, these reports, coordination; the harness keyboard fix for API 26 |

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
  nothing is dropped silently, and there is no chunk-and-merge in v1.

**Proposed, not frozen:** the open questions O-1 to O-7 in §12 (due dates,
stale-source display, editing and task carry-over, retention, backups,
diagnostics on the companion, and entries too long for one request). They
block only the stages named there.

**Implementation choices recorded in the LLD (§7.2), not contract
changes:**

- refusal reasons, including `UNSENDABLE_TEXT` for written text with
  characters §6 forbids, so content is never rewritten;
- an `organize_secret` table, kept out of `app_settings` and backups;
- one organize at a time.

## 3. Schemas and vectors

| Artifact | Count |
|---|---|
| Fixtures | 7, one exactly at the 61,108-byte input cap |
| Input cases | 37 (7 valid) |
| Result cases | 79 (10 valid): exactly at the 61,387-byte output cap, one byte over, and (amendment A1) partial results, including one at the cap, plus 9 completeness cases |
| Event sequences | 12 |
| Whole-message envelopes | 4: request and completed event, each at 61,440 bytes and one byte over |
| Request keys | 7, under a published test key |

Four independent checks pass on these artifacts:

- `generate-vectors.mjs --check` rebuilds every file byte for byte;
- the Python verifier reports 0 failures;
- Ajv 6 compiles the schemas and accepts every valid case;
- the app's TypeScript validator reaches every verdict and sub-code
  (`unit-tests/organizeContract.test.ts`).

The app's request builder rebuilds all 7 fixtures byte for byte from journal
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

- all 126 organize runs completed and were validated, with persistence
  rehearsed in rolled-back transactions; none was committed (the stored
  derivations are the functional cases in §5.1);
- warm completion is 38–52 ms p50 from 30 s to 10 min of speech, and
  143 ms p50 at the exact 61,108-byte cap;
- the result is on screen at 64–230 ms p50;
- the typed refusals sent nothing;
- the SDK rejected cap + 1 with `SCHEMA_VALIDATION_FAILED`;
- the deadline ended 3 ms after 60 s.

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

- The full Organized and Tasks UI, which depends on O-1 to O-3.
- Physical-device runs. Only emulators were used.
- iOS: no macOS/Xcode evidence.
- Voice entries on the device: the request builder, validator, and storage
  cover voice units and audio ranges on the host (§4). The device suite
  organizes written entries, because a final transcript on the emulator
  needs the speech harness.
