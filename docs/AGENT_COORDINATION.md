# Agent Coordination

Operational shared memory for ChatGPT Work/Codex, Cursor, and human contributors.
Permanent decisions belong in the canonical documents linked from `README.md`.

## Current snapshot

- **Phase:** AJ-1 (Android, emulator evidence) and the AJ-3 node workflow are on
  `main`; neither milestone is accepted. AJ-2.0 and AJ-2.1 are implemented on
  branch `aj2/organize` (not merged); AJ-2 is not accepted.
- **Branch:** `main`.
- **Last agent:** Claude Code `hybridai-81` (AJ-2.0/2.1 on `aj2/organize`).
- **Last updated:** 2026-10-11.
- **AJ-3 (updated 2026-10-10 19:40 by `hybridai-7b`).** The Android node
  workflow passes 20 of 20 device steps on the AJ-1 fix build `72ee323`, in
  a fresh run. The milestone is not accepted:
  - the fix is on `aj1/domain-core`, not on `main` (gated merge);
  - the exit also needs AJ-1 and AJ-2;
  - iOS is deferred.

  `main` (`52cb23d`) still fails S12, S13, and S17 (status defects F1 and
  F2). Report: `docs/validation/AJ3-android.md` (`73c7bae`).
- **Implementation status:**
  - AJ-0 is not accepted (volatile PIN).
  - AJ-3 node workflow and the load lab are implemented; validation is
    partial.
  - App-owned on-device transcription (ADR-016) is implemented and
    benchmarked (`52cb23d`).
  - AJ-1's Android implementation is provisionally complete on emulator
    evidence and is **merged into `main`** (`a759db8`, 2026-10-11), with the
    F3 and status-recovery fixes after it (`57f316c`, `f294c87`); not
    accepted (physical-device, live-timing, and iOS gates deferred).
  - AJ-2.0 and AJ-2.1 are implemented on `aj2/organize`
    ([AJ-2 progress](validation/AJ2-progress.md)): the frozen
    `journal.organize@1` contract, `node-companion/`, and the app
    integration through the public SDK. The Organized/Tasks UI has not
    started.

## Parallel-work claims (updated 2026-10-10 00:25 IST)

- **Speech/performance track (`hybridai-7b`): handed off 2026-10-10.**
  - **Commits on `main`:** `87566c8` (on-device whisper engine, speech plan,
    `aj-speech` harness), `2263ca2` (ADR-017/018), and `52cb23d` (in-app
    speed, early cancel acknowledgement, `/proc`-only sampling, and the
    format fix). Nothing of this track is left uncommitted.
  - **Ownership released.** Per the owner decision of 2026-10-10 00:09,
    which `hybridai-7b`'s user confirmed, `hybridai-81` is sole owner of the
    native AJ-1 layer, the build graph (`android/*.gradle`, CMake,
    `MainApplication.kt`, `codegenConfig`), `src/native/`,
    `src/features/transcription/`, navigation and `AppServices` wiring, and
    integration. The emulator is shared only through `.aj-exclusive-run`.
  - **AJ-3 validation state (2026-10-10 19:40).**
    - **Commits on `main`:** `ccef770` (harness, accepted in `AJ3-REV-002`
      and `AJ3-REV-004`) and `73c7bae` (AJ-3 report, SDK backlog findings
      `docs/validation/hybrid-ai-sdk-issues.md`, AJ-4-A status line).
    - **Runs and evidence** (git-ignored, `e2e/speech/results/`):
      - `aj3-run5`: `main`, 17/20, composite;
      - `aj3-aj1-94604ca`: 17/20, fresh;
      - `aj3-fix-72ee323-targeted`: 7/7;
      - `aj3-fix-72ee323-full`: 20/20, fresh, non-resumed,
        `--expect-persistent-pin`, full-run log scan.
    - **Decisions** (inbox `/home/igdclt0603/Desktop/Ash/AJ_AGENT_DECISIONS.md`):
      - `AJ3-REV-001` and `AJ3-REV-003`: CHANGES_REQUIRED, fixed by
        `hybridai-81` (`0ced9a6`, `72ee323`) and verified;
      - `AJ3-REV-002` and `AJ3-REV-004`: ACCEPTED;
      - `AJ3-DEC-001`: DECIDED (SDK findings kept here; SDK repository not
        edited).
    - **Merge-gate regression done (2026-10-10 23:58):**
      - final AJ-1 APK `6f2b36b` (SHA-256 `cb4ff897…f4b7d`), fresh
        non-resumed S00–S19: **20/20 pass**, harness `84d3b4c`;
      - evidence in `e2e/speech/results/aj3-final-6f2b36b`;
      - report §8.3 (`aa7f55b`);
      - lock auto-released.
    - **F3 closed** (`78a9295`), and F5 (status stayed "Unavailable" after a
      node result with no tap) fixed (`57f316c`) by `hybridai-81`; S13 is now
      tap-free (`f294c87`). See `docs/validation/AJ3-android.md` §8.4–8.5.
    - **Validation commands:**
      - `ANDROID_SERIAL=emulator-5556 node e2e/android/aj3-e2e.mjs --apk <apk> --expect-persistent-pin --out <dir>`;
      - targeted: `--only S00,S01,S02,S06,S12,S13,S17`;
      - checks: `node --check` and `prettier --check "e2e/**/*.mjs"` pass.
    - **Locks:** none held by `hybridai-7b`. `emulator-5556` was shut down
      on 2026-10-11 at `hybridai-81`'s request; the marker
      `.aj-exclusive-run-5556` remains. `hybridai-7b` has stopped (owner
      instruction).
  - **Remaining claim: test harness and reports only, no product code.**
    `e2e/android/{aj3-e2e.mjs,aj-load.mjs,aj-speech.mjs,lib/,nsd-fixture/}`
    and `e2e/speech/`, plus new report files
    `docs/validation/AJ3-android.md` and
    `docs/validation/speech-and-load-baseline.md`.
  - **Verified baseline (`52cb23d`).** Release APK with R8, emulator
    `aj-api35-4g` (API 35, 4 GB, 4 vCPU), 20 LibriSpeech speakers, in-app,
    4 threads. All 20 files were SHA-256-verified on device, in-app and host
    WER agree on every file, and no transcripts appeared in logcat.
    - `base.en-q5_1`: WER 5.83%, RTF 0.616, cancel acknowledgement
      0.33 ms, compute release about 4.7 s, peak RSS 354 MB.
    - `tiny.en-q5_1`: WER 9.17%, RTF 0.252, compute release about 1.7 s,
      peak RSS 305 MB.
  - **Benchmark rules learned.**
    - Keep the UI static during runs. An animated spinner cost 3x on the
      emulator's CPU compositor because ggml's barrier threads stall when
      one is preempted.
    - Never `dumpsys meminfo` the app mid-run.
    - whisper.cpp v1.9.5 checks its abort callback only between encoder
      and decoder passes, so cancellation compute release takes up to one
      encoder pass.
  - **Note for AJ-1 (owner `hybridai-81`).** Per ADR-017, the
    TranscriptionService native path must take natively decrypted AJR1 PCM
    instead of a WAV path. The live-window threads should leave one core
    free while the UI animates; measured guidance only.
- **AJ-1 track: Claude Code session `hybridai-81`.** Updated 2026-10-11.
  - **Merged into `main`** (owner-authorized, local only; nothing pushed):
    - `c0938c3`: this file as both tracks left it (coordination only);
    - `a759db8`: merge of `aj1/domain-core` (`78a9295`), no conflicts;
    - `57f316c`: a node result restores Connected without a tap (F5);
    - `f294c87`: tap-free S13, settled capture timer, F3 node check;
    - the documentation commit with this entry.
  - **Final APK:** `/home/igdclt0603/Desktop/Ash/aj1-artifacts/app-release-main-f294c87.apk`,
    SHA-256 `c4b61818fbd56b88dbe7af6fbe203216ff26d3a343f5ae46b311f835dba90e22`.
  - **Final validation on `f294c87`** (`emulator-5554`): JS baseline 381/381
    (unit 244, smoke 3, integration 128, performance 6); JVM 58/58;
    instrumented app 6/6; AJ-1 smoke 7/7 and capture 6/6; F3 node check 3/3;
    AJ-3 S00–S19 20/20 (fresh, non-resumed,
    `e2e/speech/results/aj3-main-f294c87/`). Backup 8/8 and biometric 5/5 ran
    on the merged APK `a759db8`. Details: `docs/validation/AJ1-progress.md`
    (merge section) and `docs/validation/AJ3-android.md` §8.4–8.5.
  - **Branch `aj1/domain-core`** stays at `78a9295` (merged); the worktree
    `../audio-journal-aj1` and `../aj1-build-72ee323` can be removed by the
    owner when no longer needed.
  - **Deferred, not passed:** physical-device Argon2id, memory/latency, and
    the AJB1 production profile; live-transcription window/overlap/cadence
    (PROVISIONAL, Open decision 3); iOS (macOS/Xcode). No acceptance is
    claimed.
  - **Emulator:** `emulator-5554` is shut down after the run;
    `.aj-exclusive-run` is released.
  - **Next:** AJ-2 has not started; it waits for the owner.
- **AJ-2 track: Claude Code session `hybridai-81`.** Started 2026-10-11;
  last updated 2026-10-11.
  - **Where:** worktree `../audio-journal-aj2`, branch `aj2/organize`, from
    `main` `c5fb510`. Not merged, not pushed, not released.
  - **Commits:** `58d1587`, `9c6d3d4` (contract), `8e3695a` (schemas,
    vectors, verifier), `d0e5fe2` (companion), `0b064f8` (app through the
    public SDK), `c33a2f1` (companion pairing fix), `491dfd9` (organize
    performance suite, device harnesses), then the evidence and docs
    commit.
  - **Done:**
    - AJ-2.0: the contract (ADR-019, `docs/journal-organize.md`).
    - AJ-2.1:
      - `node-companion/` with the TLS 1.3 and TLS 1.2 + EMS profile;
      - the minimum app integration (consent, streaming, cancel,
        validation, atomic storage, migration 3);
      - the minimal UI.
    - The organize performance suite.
    - Evidence: [AJ-2 progress](validation/AJ2-progress.md) and the
      [organize performance suite](validation/AJ2-organize-performance.md).
  - **Validation:**
    - JS baseline: unit 287, smoke 3, integration 142, performance 6.
    - Companion 36/36; JVM 61/61; release build.
    - Device (API 35 emulator): functional suite 9/9; performance suite
      complete (development baseline).
    - API 26 and 28 TLS proof with the real app: TLS 1.2 ECDHE-ECDSA
      AES-GCM with EMS, 7/7 handshakes each, organized and stored.
  - **Remaining (not started):**
    - the Organized and Tasks UI (O-1 to O-3);
    - O-7 (entries too long for one request);
    - physical-device performance matrix and iOS (AJ-4).
  - **SDK findings for the owner:** SDK-AJ-4 (undocumented framing and
    status) and SDK-AJ-5 (a cancel during a pending event read never
    reaches the node), in `docs/validation/hybrid-ai-sdk-issues.md`.
    SDK-AJ-1 and SDK-AJ-2 stand, with the app-side compatibility
    workaround.
  - **Emulators:** `aj-api35-4g` (5554) was used and stopped. The new AVDs
    `aj-api26` and `aj-api28` (5560, 5562) are stopped after their runs.
    The SDK session's `hybrid-ai-api26`/`hybrid-ai-api28` were not touched.
  - **Open questions:** `docs/journal-organize.md` §12 (O-1 to O-7).
- **Exclusive runs.** Benchmarks, emulator suites, Gradle/CMake builds, and
  Jest baselines never overlap. Create
  `/home/igdclt0603/Desktop/Ash/.aj-exclusive-run` (owner, purpose, start)
  with `set -o noclobber`; do not start heavy work while it exists; delete it
  when done. In wait loops, use bracketed `pgrep` patterns such as
  `[G]radleWrapperMain` and `^[n]ode .*aj-speech`. A plain pattern matches the
  loop's own command line, so the loop never exits.
- **AJ-1 gates still open:**
  1. Argon2id `m/t/p`, memory/latency acceptance, and the AJB1 production
     profile need the lowest-supported **physical** Android device. None is
     available; the emulator is not substituted.
  2. Live window, overlap, and cadence come from device measurements.

  AJB1 §9 is frozen for implementation (`94604ca`), and AJR1 Open decision 7
  is closed.
- **Fixed on `main`:** the `87566c8` format:check failure on
  `e2e/android/aj-speech.mjs` (fixed in `52cb23d`).

## Completed

- Created the Audio Journal product repository and canonical documentation set.
- Initialized a local Git repository on branch `main`; no commit or remote was
  created because neither was requested.
- Captured the frozen local/private-first, no-account, app-lock, source-of-truth,
  diary/organized-mode, live-transcription, and Hybrid AI boundary decisions.
- Added the proposed “Quiet Archive” visual direction: warm paper/moss palette,
  editorial date/title hierarchy, bottom navigation, core screen compositions,
  component inventory, failure states, and visual acceptance criteria.
- Corrected the UI model to expose explicit Diary and Organized views, including
  Work and Personal sections, and made exact transcript/audio-range provenance
  a mandatory, playable reference for every voice-derived task.
- Added user-controlled portable encrypted backup and empty-vault restore for
  app-data clear/reinstall recovery. The archive includes journal content and
  provenance but excludes PIN/biometric/device keys and node pairing credentials.
- Preserved the interactive UI/UX design inside `docs/design/` as an editable
  fragment plus a standalone browser-ready HTML review file. The prototype now
  includes Backup & restore states.
- Marked encryption mechanics, exact audio/STT integration, capability schemas,
  portable-backup cryptographic/container details, retention, and destructive
  recovery details as open where not yet approved.
- Generated the React Native 0.87 TypeScript/New-Architecture native scaffold
  without modifying the sibling SDK repository.
- Added lock-gated Diary/Organized/Tasks/Settings navigation, replaceable lock
  and biometric ports, a volatile scaffold verifier, lifecycle relock, privacy
  curtain, Android `FLAG_SECURE`, and a public-root Hybrid AI adapter.
- Added separate unit, component-smoke, integration, and performance Jest
  projects plus one-command baseline validation.
- Reconciled React Native's compile API 36 requirement with SDK min API 26 and
  target API 35, and recorded the exact AJ-0 dependency profile in canonical docs.

## Next work

1. Have the SDK M5.2 work expose a valid Metro/public package entry and correct
   the CLI-invalid iOS autolinking metadata, then reinstall the package.
2. Rerun the Metro bundle and API 35 emulator smoke, including real SDK initialization.
3. Resolve the pre-implementation security ADR covering database and recording
   encryption, PIN KDF/key wrapping, biometric key invalidation, and local reset.
4. Replace the volatile credential and unavailable-biometric adapters only after
   that security decision, then complete AJ-0 device lock tests.
5. Resolve the audio/STT pipeline ADR and freeze `journal.organize@1` schemas before AJ-1/AJ-2.

## Validation

- `npm run test:baseline` passed: typecheck, zero-warning lint, 12 unit,
  1 component smoke, 4 integration, and 1 performance test.
- Android `:app:assembleDebug` passed against the SDK native binding after API
  36 was installed; it produced a debug APK but did not prove JS runtime startup.
  The native module came from live SDK HEAD `27cc99c` plus uncommitted M5.2 work,
  so this is compatibility evidence rather than an accepted SDK baseline.
- Production-style Metro bundling failed because `@hybrid-ai/react-native`
  0.1.0-m4 has no resolvable JS package entry. Full evidence and the exact
  rerun commands are in `docs/validation/AJ0-progress.md`.
- Documentation validation passed for 17 Markdown files: balanced code fences,
  existing relative link targets, and 46 unique requirement/business-rule IDs.
- Trailing-whitespace scan passed. Git root and branch resolve to this repository
  and `main`; all created files remain untracked in the new repository.
- The interactive “Quiet Archive” UI concept was rendered and visually checked
  at 736×1000 and 360×900. It is a design reference, not application code.
- The revised Organized screen and exact task-source playback screen were
  separately rendered and visually checked at 736×1000 and 360×900.
- The Backup & restore screen was rendered and visually checked at 360×900.

## Known constraints

- Hybrid AI SDK v0.1 is still progressing in the sibling repository.
- The local Hybrid AI dependency is a development file link, not a releasable
  pinned artifact. Its native Android graph assembles, but its JS package does not bundle.
- The AJ-0 credential verifier is deliberately volatile and non-cryptographic;
  it must never be described or shipped as production app-lock storage.
- iOS validation requires macOS/Xcode and remains a future execution dependency.
- No remote is configured for this repository unless a later task explicitly adds one.
