# Agent Coordination

Operational shared memory for ChatGPT Work/Codex, Cursor, and human contributors.
Permanent decisions belong in the canonical documents linked from `README.md`.

## Current snapshot

- **Private AI Node ownership/stack clarification (2026-10-13, Codex):** AJ's
  technology stack is explicitly application-only. The cross-platform desktop
  node stack belongs to the SDK repository; accepted SDK ADR-025 defines a
  native C++20/CMake service + CLI with Boost.Asio/Beast, OpenSSL 3,
  `llama.cpp`, and OS adapters. AJ docs link to it and retain no server
  framework or desktop-OS branch. The AJ technology document is also reconciled
  with implemented Android reality (native SQLCipher/vault/biometrics/audio,
  repository device harness, React contexts/controllers) instead of stale
  Expo/Zustand/Detox candidates. No app/source, package, build, test, or gate
  changed.
- **Three-product boundary accepted (2026-10-13, owner/Codex):** SDK ADR-026
  and AJ `product-boundaries.md` forbid SDK/node private source or desktop
  server code in AJ. AJ consumes public packages and supplies only a bounded
  declarative capability bundle to the already-built generic node. App-owned
  Whisper and `node-companion` leave product builds at AJ-RI-2/AJ-RI-4, with
  automated artifact/import/symbol checks. Documentation only.
- **Mobile platform clarification (2026-10-13, owner/Codex):** Audio Journal
  and its Hybrid AI SDK integration target both Android and iOS. Android/API 35
  is the currently executable first development profile, not the product
  boundary. AJ-RI must preserve iOS app/API parity, label it unverified until
  run, and pass cumulative `GRI-6-I` on macOS/Xcode and supported iOS devices
  before cross-platform mobile support or v0.1 release is claimed.
- **Node platform correction (2026-10-13, owner/Codex):** AJ uses the same SDK
  node API for Linux, Windows, and macOS. Ubuntu is only the first Linux
  validation distribution; Windows/macOS require native SDK-owned node gates
  before support claims. AJ contains no host-OS branch. Documentation only; no
  implementation/platform gate changed and no claim remains active.
- **Future context direction (2026-10-12, owner/Codex):** node-initiated
  requests for more journal context/device capabilities are recorded as
  post-AJ-RI only. They require a separate typed, bounded, consented SDK
  protocol plus AJ UX/security decision; AJ remains data authority. Node
  quality claims use actual hardware and never assume frontier capability. No
  AJ-RI gate or implementation changed; no claim remains active.
- **GRI-0 accepted (2026-10-12, owner/Codex):** an independent read-only agent
  reviewed SDK baseline `7e5373d` and AJ baseline `ec1c3fd`, found four
  blockers and four follow-ups, then cleared every item after remediation in
  SDK `5bb6a39` and AJ `56ca1bc`. AJ-RI may proceed only behind the matching
  accepted SDK package gates.
- **AJ-RI documentation handoff (2026-10-12, Codex):** ADR-021 and the
  resumable [real-inference migration](real-inference-migration.md) are written
  and reconciled through scope, use cases, HLD, LLD, UML, organization
  contract, technology stack, roadmap, and index, committed by `ec1c3fd` and
  corrected by `56ca1bc`. Documentation only: no app, native, companion,
  package, model, test, merge, push, or release changes. Historical AJ-1–AJ-4-P
  results remain intact; direct Whisper and `aj.rules` are explicitly pre-RI
  evidence, not the target architecture.
- **Tailscale prototype profile (2026-10-12, amended 2026-10-13):** frozen as
  an external Android-to-desktop-node profile. Linux/Ubuntu is validated first;
  Windows/macOS repeat the relevant proof in their SDK platform gates. AJ
  embeds no Tailscale code and retains SDK pairing/mTLS.
- **AJ-RI status:** implementation has not started. `GRI-0` is accepted. Next
  AJ feature work is AJ-RI-2/3/4 only after the corresponding SDK package gate.
  No active Codex file claim remains.
- **Validation:** `git diff --check` passes in both repositories; a read-only
  checker validated balanced Markdown fences and relative link targets across
  62 Markdown files; new-file trailing-whitespace scan passes. No build/test
  suite was run because only documentation changed.

- **Phase:** AJ-4-P is historical prototype evidence; AJ-RI is the mandatory
  next program and `GRI-0` is accepted. AJ-4-E remains deferred. AJ-4-P is
  complete on merged `main`
  ([AJ-4 progress](validation/AJ4-progress.md)). The owner's records of
  2026-10-12:
  - AJ-1 and AJ-3 are accepted for the Android-emulator development profile;
  - AJ-2 is accepted for the Android-first profile.

  None of these is canonical, production, or cross-platform acceptance.
  Physical Android production certification and iOS execution stay deferred;
  iOS remains a supported target governed by `GRI-6-I`. Only the bounded
  Tailscale phone-connectivity proof is inside `GRI-6-A`.
- **Branch:** `main`; accepted AJ-RI design baseline through `56ca1bc`.
  AJ-4-P was merged as `ff669a7`; AJ-2 was merged as `692ac0b`.
- **Last agent:** Codex (GRI-0 review remediation and acceptance; no
  implementation).
## Historical coordination record

Items below retain earlier agent handoffs and may describe branch state at that
time. They are not the current milestone/status; use the snapshot above and the
canonical RI documents.

- **AJ-4-P handoff (2026-10-12, Claude Code; originally on
  `aj4/hardening`, later merged as `ff669a7`; not pushed or released).** The report is
  [AJ-4-P product reality](validation/AJ4P-product-reality.md).
  - **Prototype:** release APK `7df7e740…` (`arm64-v8a` and `x86_64`;
    `c4b302e` SDK core verified; debug-signed) and `e2e` APK `81f7b358…`,
    in `aj1-artifacts/evidence/aj4p/apk-a3b25a5/`.
  - **Results (API 35 emulator; development measurements):**
    - product journey 12/12;
    - cold launch 478 ms, warm 81 ms;
    - capture start 38 ms, playback start 48 ms;
    - stop → final transcript: 30 s about 17 s, 1 min about 30 s, 3 min
      63 s, 5 min 101–117 s, 10 min 190–205 s (RTF about 0.31–0.51);
    - organization completes in 31–60 ms p50 (55–142 ms on screen), with
      30/60 min refused as typed;
    - 18-minute stability: 49 operations, 0 failures, 0 crashes, and
      memory on a plateau;
    - host baseline: unit 313, smoke 3, integration 153, performance 6.
  - **Fix:** `a3b25a5`, the live transcript is bounded so Finish stays on
    screen (UX §5).
  - **Remaining:** the owner's physical-phone trial (report §11). The
    AJ-4-E inventory is deferred. Canonical AJ-4 stays open.
  - **Environment:** the emulator is stopped, and `.aj-exclusive-run` is
    released.
- **Last updated:** 2026-10-12.
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
  - AJ-2.0, AJ-2.1, and AJ-2.2 are accepted for the Android-first profile
    and merged into `main` (§11). The record of what was implemented
    ([AJ-2 progress](validation/AJ2-progress.md)): the frozen
    `journal.organize@1` contract, `node-companion/`, and the app
    integration through the public SDK. AJ-2.2 (due dates, history,
    staleness, task states, and the Organized and Tasks UI) is implemented
    and validated on emulators
    ([AJ-2 progress §9](validation/AJ2-progress.md#9-aj-22-organized-and-tasks-2026-10-12)).

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
  - **Owner decision, 2026-10-11:** AJ-2.0 and AJ-2.1 are accepted as
    completed development checkpoints. This is not AJ-2 acceptance, and
    there is no merge.
  - **Amendments before AJ-2.2: done** (`b4aea98`, `ad430fc`, `cc763bd`,
    and the evidence commit). See
    [AJ-2 progress §8](validation/AJ2-progress.md#8-owner-amendments-before-aj-22-2026-10-11):
    1. the performance results are labelled the deterministic `aj.rules`
       baseline;
    2. amendment A1 makes partial results explicit (ADR-019, schemas,
       vectors, validators, companion, UI, UX, performance rerun);
    3. SDK-AJ-5 is recorded as the blocker for cancellation acceptance,
       with the handoff and re-test in `hybrid-ai-sdk-issues.md`;
    4. the real voice-entry journey passed 7/7 on the `e2e` build;
    5. the wording on rehearsed persistence is corrected.
  - **Validation (amended build):**
    - JS: unit 289, smoke 3, integration 144, performance 6.
    - Companion 40/40; vectors `--check` and the verifier pass with 0
      failures; JVM 61/61.
    - Release and `e2e` builds pass.
    - Device (API 35 emulator): functional 9/9 (`ad430fc`), voice journey
      7/7 (`cc763bd`), and the performance rerun complete.
  - **Blocked:** final AJ-2 cancellation acceptance, on SDK-AJ-5 (an SDK
    fix and a re-test). The SDK repository was not changed. The handoff is
    the SDK-AJ-5 section; no peer session is identified as the SDK owner.
  - **Owner decision, 2026-10-12:** O-1, O-2, and O-3 are approved with
    amendments. AJ-2.2 is in progress on `aj2/organize` (no merge, push,
    release, or acceptance claim):
    - O-1: due dates, as contract amendment A2, with an independent
      re-derivation in the app validator;
    - O-2: history and computed staleness;
    - O-3: task states and conservative carry-over.

    It covers the Organized and Tasks UI, then the cumulative suites.
    **Touches:**
    - the contract and ADR-019, `schemas/journal/v1/`,
      `tools/journal-organize/`;
    - `node-companion/` (engine and validator);
    - `src/features/organize/`, storage migration 4, `src/app/navigation/`;
    - `e2e/aj2/`, and the UX, LLD, and validation documents.
  - **AJ-2.2 handoff (2026-10-12):** implemented and validated on emulators;
    not merged, pushed, released, or accepted.
    - **Commits:** `c0edd93` (A2, ADR-020), `10ced20` (migration 4,
      carry-over, staleness), `d865385` (Organized, History, and Tasks
      views), and the evidence commit.
    - **Permanent docs:** contract §3.3 and A2, ADR-019, ADR-020, UX §7,
      LLD §7.3, HLD, UML, roadmap §4,
      [AJ-2 progress §9](validation/AJ2-progress.md#9-aj-22-organized-and-tasks-2026-10-12),
      and SDK-AJ-5 in `hybrid-ai-sdk-issues.md`.
    - **Validation:** `npm run test:baseline` (unit 308, smoke 3,
      integration 153, performance 6); companion 42/42; vectors `--check`
      and the verifier with 0 failures (68 due-date cases); JVM 61/61;
      release and `e2e` builds. Device (API 35 emulator, sequential under
      the lock): Organized and Tasks 11/11, functional 9/9, voice journey
      7/7, the performance rerun complete (`perf-api35-run3`), and the AJ-3
      regression S00–S19 20/20 (fresh run, `aj3-regression-d865385`).
      Evidence: `aj1-artifacts/evidence/aj2-device/`.
    - **Harness fixes:** the AJ-3 harness scrolls to the diagnostics request
      card, which AJ-2.1's benchmark card pushed below the fold; the voice
      helpers moved to `e2e/aj2/lib/voice.mjs`.
    - **Blocked:** final cancellation acceptance, on SDK-AJ-5. The
      re-test (`--expect-node-cancel`) is prepared but cannot pass until a
      fixed packaged SDK is installed. Companion `DELETE` evidence proves
      the companion only. It still reproduces on `d865385` (O03).
    - **Remaining:** owner review of AJ-2.2; the SDK-AJ-5 fix and re-test;
      O-4 to O-6 and O-7 chunking (deferred); physical-device and iOS
      gates.
  - **Emulators:** stopped; `.aj-exclusive-run` is released.
  - **SDK-AJ-5 package integration and AJ-2 closing baseline (2026-10-12,
    Claude Code; complete; not merged, pushed, released, or accepted).**
    - **Pin.** SDK packages from `c4b302e` (SDK branch
      `fix/sdk-aj-5-node-cancel`, accepted and merged into SDK `main` by `855edaf`;
      ADR-015 amendment). AAR
      `8751a5a7…b1a`, RN tarball `a11cba67…e2a`, both verified. No
      `e0fc3c5` remains in the build inputs; the APKs embed the accepted package's
      `libhybrid_ai_core.so`.
    - **Commits:**
      - `aabc8b1`: the pin;
      - `2903a7c`: the strict closing checks;
      - the follow-up harness and evidence commits.
    - **Validation**
      ([AJ-2 progress §10](validation/AJ2-progress.md#10-sdk-aj-5-packages-and-the-aj-2-closing-baseline-2026-10-12)):
      - JS baseline: unit 308, smoke 3, integration 153, performance 6;
      - JVM 61/61; release and `e2e` builds;
      - SDK-AJ-5 closing test 2/2 and strict cancel block 5/5;
      - functional 9/9, voice 7/7, Organized/Tasks 11/11;
      - the full performance matrix complete;
      - fresh AJ-3 S00–S19 20/20;
      - API 26 and 28 TLS 1.2 smokes pass;
      - the privacy scan: 0 findings in 54 logs, plus the API 26 and 28
        device logs from repeat smokes (`privacy-api26-28/`: streamed
        logcat with start and end markers; 0 findings in 4 logs).

      The closing baseline passed technically. AJ-2 was then accepted for
      the Android-first profile and merged (see the outcome below).
    - **Evidence hygiene (2026-10-12):** see AJ-2 progress §10.
      - The privacy scanner was extended and self-tested.
      - The final scan over `aj2-device` and `aj2-sdkaj5` found 0 findings
        in 131 device, companion, and boot logs. One finding is in a
        superseded harness console summary.
      - O06 was rerun with the committed harness (`b7b7d0c`) against the
        accepted APK: refused, reason shown, 0 jobs sent.

      Evidence is in `aj1-artifacts/evidence/aj2-sdkaj5/`. Release APK
      `22c0f35d…e015`.
    - **SDK-AJ-5** is closed in the AJ path by consumer evidence, and the
      pre-job-ID limitation is kept.
    - **Outcome (2026-10-12):**
      - The SDK owner accepted SDK-AJ-5 and merged it into SDK `main`
        (`855edaf`; `main` at `59b2cd8`; package source `c4b302e`; hashes
        unchanged).
      - The owner accepted AJ-2 for the Android-first profile (AJ-2.0 to
        AJ-2.2, the deterministic `aj.rules` baseline, SDK-AJ-5 closed).
      - The historical `voice-api35-run3` console finding is classified as a
        non-blocking test-harness finding.
      - Harness failure messages now withhold screen text, pinned by
        `harnessFailureMessages.test.ts`.
      - Deferred and unpassed: physical Android, iOS, O-4 to O-6, and O-7
        chunking.
    - **Merged into `main` (2026-10-12):** merge commit `692ac0b`
      (non-fast-forward; history kept). The merged tree is identical to the
      accepted branch tip `67f74fa`, and there were no conflicts.
    - **Post-merge smoke on `main`:**
      - `npm ci`, then `npm run test:baseline`: unit 310, smoke 3,
        integration 153, performance 6;
      - JVM 61/61, and `assembleRelease` passes;
      - the release APK `ae8378a4…` embeds the accepted `c4b302e`
        `libhybrid_ai_core.so` for both ABIs (byte-identical to the AAR; not
        `e0fc3c5`). The APK hash differs from the evidence APK `22c0f35d…`
        because release builds are not byte-reproducible; the native core
        is identical;
      - the package and AAR pins and the lockfile integrity are unchanged,
        and `SHA256SUMS` verifies.

      Nothing was pushed or released. Emulators are stopped, and
      `.aj-exclusive-run` is released.
    - **Environment note.** Timing evidence needs AC power. On battery the
      host ran at about 1.05 GHz and a timing test failed.
    - **Emulators:** stopped; `.aj-exclusive-run` is released.
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
