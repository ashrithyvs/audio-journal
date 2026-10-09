# Agent Coordination

Operational shared memory for ChatGPT Work/Codex, Cursor, and human contributors.
Permanent decisions belong in the canonical documents linked from `README.md`.

## Current snapshot

- **Phase:** AJ-0 documentation and repository foundation.
- **Branch:** `main` after Git initialization.
- **Last agent:** Claude Code `hybridai-7b` (speech/performance handoff).
- **Last updated:** 2026-10-10.
- **AJ-3 claim: closed** by `hybridai-7b`. The code is in
  `58d8f94`/`af49f6c`. Device validation is partial: S00–S08 passed on the
  R8 release build, and S09–S19 are still to be re-run (harness fixes, no
  product failure). The AJ-3 evidence report is pending.
- **Implementation status:**
  - AJ-0 is not accepted (volatile PIN).
  - AJ-3 node workflow and the load lab are implemented; validation is
    partial.
  - App-owned on-device transcription (ADR-016) is implemented and
    benchmarked (`52cb23d`).
  - AJ-1 is in progress in `hybridai-81`'s worktree.
  - AJ-2 has not started.

## Parallel-work claims (updated 2026-10-10 00:00 IST)

The AJ-3 claim above appears delivered in `58d8f94`/`af49f6c`; its owner
should close it.

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
- **AJ-1 independent track: Claude Code session `hybridai-81`.** Worktree
  `../audio-journal-aj1`, branch `aj1/domain-core`, fast-forwarded to
  `2263ca2`, no commits. New files only:
  - `src/features/journal/{domain,ports,application,ui}/`
  - `src/features/backup/domain/`
  - `src/platform/storage/`
  - `test/{sqlite,journal}/`
  - `{unit,integration,smoke,performance}-tests/journal*`
  - `unit-tests/backupInventory.test.ts`
  - `docs/validation/AJ1-progress.md`
  - a **Proposed**, unfrozen AJB1 layout appended as §9 of the worktree's
    `docs/backup-and-restore.md`

  In this tree, it edits only this file. Evidence:
  [AJ-1 checkpoint 1](../../audio-journal-aj1/docs/validation/AJ1-progress.md)
  (worktree). The AJ-1 gate is **not met**; AJ-2 is not started.
- **Serialized, waiting for the speech handoff and owner direction:**
  - transcription-port changes, so AJR1 PCM is decrypted natively rather than
    read from a WAV path;
  - live windows;
  - every Gradle, CMake, codegen, `package.json`, or lockfile change
    (SQLCipher, androidx.biometric, libargon2);
  - the native vault, recorder, playback, and SQL modules;
  - `AppServices.ts` and navigation wiring;
  - canonical-doc edits;
  - every device run.
- **Exclusive runs.** Benchmarks, emulator suites, Gradle/CMake builds, and
  Jest baselines never overlap. Create
  `/home/igdclt0603/Desktop/Ash/.aj-exclusive-run` (owner, purpose, start)
  with `set -o noclobber`; do not start heavy work while it exists; delete it
  when done. In wait loops, use bracketed `pgrep` patterns such as
  `[G]radleWrapperMain` and `^[n]ode .*aj-speech`. A plain pattern matches the
  loop's own command line, so the loop never exits.
- **AJ-1 gates still open:**
  1. Argon2id `m/t/p` need a benchmark on a *physical* lowest-supported
     Android device; only the emulator is attached.
  2. The owner must freeze AJB1 §9 (layout, caps, vectors).
  3. Live window, overlap, and cadence come from device measurements.

  ADR-017/018 are committed (`2263ca2`), so the earlier conflicts are
  resolved.
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
