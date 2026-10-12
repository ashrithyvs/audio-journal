# Implementation Roadmap

**Status:** Historical AJ-0–AJ-4-P stages are implemented/recorded as noted
below. ADR-021 now adds the mandatory AJ-RI migration before release work; see
`real-inference-migration.md`.

## 1. Delivery rules

1. Work in milestone order unless a documented dependency permits preparation.
2. Resolve Open ADRs before implementing the affected security/data/audio contract.
3. Every milestone includes unit, smoke, integration, recovery, privacy, and
   performance evidence appropriate to its surface.
4. Keep docs, schemas, tests, and implementation in one logical change.
5. Consume a pinned packaged Hybrid AI version; never import SDK private source.
6. Android-first progress is permitted in alignment with the SDK roadmap, but
   iOS catch-up is mandatory before v0.1 cross-platform/release claims.
7. Preserve unknown changes and record agent handoff state after meaningful work.

## 2. AJ-0 — Repository and application scaffold

Prerequisite: design review plus accepted security/audio decisions needed by
production adapters. UI/state/test scaffolding may proceed behind replaceable
ports, but must not claim unresolved credential/audio mechanisms are secure or
complete.

- Create React Native TypeScript app with New Architecture and native builds.
- Add navigation, feature boundaries, testing infrastructure, and public SDK package.
- Implement local lock shell, PIN setup/fallback, optional biometric prompt,
  content-obscuring background behavior, and secure-store abstraction.
- Add fake/in-memory capability adapters; no journal persistence yet.

Exit: clean install launches locked, creates/unlocks with PIN, exercises biometric
fallback on supported devices, initializes the packaged SDK, and contains no
account flow or SDK-private import.

Current checkpoint: the JS lock/navigation/privacy/test foundation and Android
debug assembly pass. Persistent PIN storage, a real biometric adapter, Metro SDK
initialization, and device smoke remain open, so AJ-0 is not accepted yet.

## 3. AJ-1 — Durable local journal capture

- Implement approved encrypted SQLite/file foundations and migrations.
- Implement voice/written entry domain, recording service, playback, timeline,
  entry detail, startup reconciliation, and storage-pressure behavior.
- Implement the accepted portable encrypted backup format, create/save flow,
  verified empty-vault restore, and cross-platform round-trip fixtures.
- Historical implementation integrated an app-owned on-device transcription
  engine. ADR-021 requires AJ-RI-2 to replace it with SDK
  `audio.transcribe@1` before the real-inference prototype gate.
- Add transcript correction and source timestamps.

Exit: voice/written capture, pause/resume, restart, playback, transcript, recovery,
offline use, verified backup, app-data-clear restore, and byte-identical recording
round-trip pass without a node; STT failure never loses audio.

**AJ-1 exit evidence** (owner, 2026-10-10). AJ-1's exit gate is its own work
and suites:

- recording with pause/resume and interruption handling;
- AJR1 playback;
- transcription directly from encrypted recordings;
- startup recording reconciliation and storage-pressure enforcement;
- AJB1 export, empty-vault restore, and their UI;
- the biometric unlock emulator test;
- voice-entry end-to-end, long-recording, and repeated-session tests;
- unit, smoke, integration, recovery, load, and performance baselines.

With emulator-only evidence, the Android implementation can be called
**provisionally complete**. Final acceptance still needs the
physical-device Argon2id and performance gate, which is deferred, not
waived. iOS needs macOS and Xcode.

**Merge gate: AJ-3 regression.** The AJ-3 secure-node suite (S00–S19) is not
part of AJ-1's exit gate. It runs against AJ-1 builds to answer one question:
did the persistent vault, navigation, storage, or lifecycle changes break the
implemented AJ-3 workflow?

- A failure caused by an AJ-1 regression blocks merging AJ-1 into `main`.
- An outdated AJ-3 harness assumption is fixed in the harness, without
  weakening its assertions.
- Each failure is classified as an application regression, an SDK
  regression, an outdated harness assumption, or a test-environment failure.
- An interim run against `app-release-94604ca.apk` is an early compatibility
  check. The full suite runs again against the final AJ-1 APK before the
  merge.

**Order** (owner, 2026-10-10):

1. Interim AJ-3 S00–S19 run against `app-release-94604ca.apk`.
2. The AJ-1 recorder.
3. Playback and startup reconciliation.
4. Transcription directly from AJR1.
5. AJB1 export/restore and its UI.
6. The biometric emulator test.
7. The voice-entry, load, and performance suites.
8. The final AJ-1 APK.
9. A full AJ-3 regression against that APK.
10. AJ-2 begins in `node-companion/` and the mobile integration layer.

**Status (2026-10-11):** steps 1–9 are done. The AJ-3 merge gate passed
20/20 on the final AJ-1 APK (`6f2b36b`), and `aj1/domain-core` is merged into
`main` (`a759db8`), followed by the F3 and status-recovery fixes and a fresh
S00–S19 on the merged build (see
[AJ-1 progress](validation/AJ1-progress.md#merge-into-main-2026-10-11)).
AJ-1 was provisionally complete on emulator evidence. **On 2026-10-12 it was
accepted for the Android-emulator development profile**
([AJ-1 progress](validation/AJ1-progress.md)). The physical-device Argon2id,
real-microphone, performance, thermal/battery, and iOS gates stay open. AJ-2.0 and AJ-2.1
are implemented on branch `aj2/organize` (see §4).

## 4. AJ-2 — Application-owned organization

- Freeze and version `journal.organize@1` request/result/event JSON schemas,
  provenance rules, and vectors (`schemas/journal/v1/`) before implementation.
- Build the node companion as a separately deployed subproject,
  `node-companion/`, in this repository (ADR-018).
- Implement explicit selection/consent, SDK streaming adapter, terminal validation,
  derivation revisions, tasks, and source-reference navigation.
- Cover malformed output, provenance escape, timeout, cancellation, retry, and
  idempotency behavior.

Exit: organization uses only public SDK APIs; valid results remain traceable and
all failure paths leave source entries unchanged.

**Status (2026-10-12): accepted for the Android-first contract/transport/UI
profile and merged
into `main`** ([AJ-2 progress §11](validation/AJ2-progress.md#11-android-first-aj-2-acceptance-2026-10-12)).
The acceptance covers AJ-2.0 to AJ-2.2 on the deterministic `aj.rules`
baseline, and SDK-AJ-5 is closed on SDK `c4b302e` (merged as `855edaf`).
It is not real-model organization acceptance; ADR-021 requires AJ-RI-3/4.
Physical Android, iOS, O-4 to O-6, and O-7 chunking stay deferred and
unpassed.

History of the milestone:

- Done:
  - AJ-2.0: the contract, schemas, vectors, and independent verifier
    (ADR-019);
  - AJ-2.1: `node-companion/`, the deterministic engine, and the minimum app
    integration through the public SDK, with consent, streaming, cancel,
    validation, and atomic storage.
- Evidence: [AJ-2 progress](validation/AJ2-progress.md).
- AJ-2.0 and AJ-2.1 are accepted by the owner as development checkpoints
  (2026-10-11); AJ-2 itself is not accepted.
- Amendments before AJ-2.2 are done:
  - explicit partial results (ADR-019 A1);
  - cited-source navigation;
  - a real voice-entry device journey;
  - the performance wording and labels.
- Blocked, then closed on 2026-10-12: final cancellation acceptance, on
  SDK-AJ-5 (an SDK fix and a re-test).
- Required for completion: the
  [organize performance suite](validation/AJ2-organize-performance.md) for
  `journal.organize@1` through the public SDK.
- AJ-2.2 is implemented on the branch, after the owner approved O-1 to O-3
  with amendments (2026-10-12):
  - explicit English due dates (ADR-019 A2), with 68 literal vectors;
  - per-selection history, computed staleness, conservative task-state
    carry-over, and task transitions (ADR-020);
  - the Organized, History, and Tasks views, with source navigation, stale
    marks, partial notices, due-date groups, and Done, Dismiss, and Restore.
  Its device and cumulative suites are recorded in
  [AJ-2 progress](validation/AJ2-progress.md).

## 5. AJ-3 — Secure Private AI Node workflow

- Add SDK-provided discovery, QR pairing, status, reconnect, forget/re-pair UX.
- Validate denied local-network permission, expired QR, spoofed candidate,
  wrong identity, revoked device, network transitions, and node unavailability.
- Verify that minimum selected transcript content—not audio by default—is sent.

Exit: a tester can pair, organize, reconnect, forget the node, and continue using
the local journal without developer tools or content loss.

**Status (2026-10-12): accepted for the Android-emulator development
profile** ([AJ-3 Android](validation/AJ3-android.md)), on repeated fresh
S00–S19 runs at 20/20, including the final AJ-2 build with the SDK
packages. The physical-network, physical-device, and iOS gates stay open.

## 6. AJ-4 — Hardening and release acceptance

- Exercise explicit `local` and `node` real-model modes and privacy-safe
  developer diagnostics. `auto` is deferred from the RI prototype.
- Test long recordings, repeated sessions, lifecycle transitions, interruptions,
  cancellation races, low storage, memory pressure, key invalidation, and migration.
- Run dependency/privacy review and plaintext-at-rest/log/backup inspection.
- Produce tester guide, fixture media, supported-device matrix, and baselines.
- Preserve the historical deterministic
  [organize performance suite](validation/AJ2-organize-performance.md) as
  contract/transport evidence. The RI suite replaces it for AI claims with
  real 30/60/180-second inputs, at most three warm repetitions, and no extended
  soak. Longer inputs move to future development.

Exit: Android and iOS journeys pass on the frozen matrix, with results attached
to the Hybrid AI SDK release evidence where required.

### 6.0 AJ-4-P: Product Reality Check (current milestone)

**Status (2026-10-12):** prototype ready for the owner's review and
physical-phone trial
([AJ-4-P report](validation/AJ4P-product-reality.md)). It is not canonical
AJ-4.

On 2026-10-12 the owner narrowed the immediate milestone to **AJ-4-P**. It is
not canonical AJ-4 acceptance, and it is not production hardening. Its
deliverables are:

- an installable Android prototype from the accepted `main`, with
  `arm64-v8a` for a physical phone and `x86_64` for the emulator;
- one end-to-end product journey on API 35;
- prototype performance for 30 s to 10 min journals (transcription and
  organization), labelled as emulator development measurements;
- a short 15–20 minute stability check;
- tester and node-companion instructions;
- a concise product-reality report answering whether the prototype is ready
  for the owner's exploratory physical-phone trial.

AJ-4-E below (§6.1) and its gap inventory are **deferred to the
production-readiness phase**. That includes:

- device-level crash injection during every operation;
- phone-call interruption;
- hostile node and backup injection;
- extended soak and reconnect loops;
- deep API 26/28 coverage;
- screenshot, recents, and clipboard certification;
- airplane-mode, low-storage, and migration-failure matrices.

Physical-device, real-microphone, biometric, thermal, and battery testing,
iOS (G0-I to G5-I), O-4 to O-7, and production signing and store readiness
are deferred as well.

### 6.1 AJ-4-E: Android emulator-validated development profile (deferred)

The owner authorized this profile on 2026-10-12. It is a gate on the way to
AJ-4, **not canonical AJ-4 and not release acceptance**. Canonical AJ-4 still
depends on the deferred physical Android and iOS profiles, which are deferred,
not waived.

- **Objective.** A feature-complete, installable Android build that a tester
  can use with the packaged Hybrid AI SDK and the separate node companion.
  It is validated on emulators, and emulator development baselines are kept
  apart from future physical-device results.
- **Baselines:**
  - Audio Journal `main` at `59339e9`;
  - SDK `main` at `59b2cd8` (merge `855edaf`);
  - packaged SDK built from `c4b302e`, with AAR `8751a5a7…b1a` and RN
    tarball `a11cba67…e2a`.
- **Stages:**
  - AJ-4.0: scope and gap freeze;
  - AJ-4.1: hardening;
  - AJ-4.2: cumulative validation;
  - AJ-4.3: acceptance preparation, then the owner's review.
- **Gate.** The journeys, validation matrix, deliverables, and the defect
  classes that cannot be accepted are frozen in
  [AJ-4 progress](validation/AJ4-progress.md). Documented minor UI defects
  or emulator-specific variance may be accepted.

### 6.2 AJ-RI — SDK-owned real local/node inference (mandatory next program)

The complete staged handoff is
[real-inference-migration.md](real-inference-migration.md), paired with SDK
ADR-024 and `hybridAi/docs/real-inference-roadmap.md`.

- AJ-RI-0: documentation/evidence reset.
- AJ-RI-2: replace app-owned Whisper with SDK `audio.transcribe@1` local.
- AJ-RI-3: real local `journal.organize@1`.
- AJ-RI-4: generic SDK Private AI Node real organization.
- AJ-RI-5: dual-mode app integration and cumulative regression.
- AJ-RI-6: installable Android emulator/CPU-node prototype, tester guide, and
  Android-to-Linux Tailscale direct/relayed connectivity proof (Ubuntu is the
  first validation distribution). Windows/macOS node validation is owned by
  the SDK's separate platform gates and requires no AJ architecture fork.

The functional/performance gate uses the API 35 emulator, CPU node, and real
30-, 60-, and 180-second voice recordings. One physical Android phone is used
only for Tailscale direct/relayed reachability. Long-audio performance,
extended soaks, `auto`, iOS, and physical-device production certification stay
deferred. Passing `GRI-6-A` authorizes broader exploratory phone testing but
does not close canonical AJ-4.

Android-first is only the current validation order. Audio Journal continues to
target Android and iOS. After `GRI-6-A`, cumulative `GRI-6-I` validates the
packaged iOS app and SDK with real local transcription, explicit local/node
organization, security, lifecycle/recovery, accuracy, privacy, bounded-load,
performance, and the AJ journeys on macOS/Xcode plus named Simulator and
physical-iPhone profiles. Simulator results do not replace device-specific
evidence. Cross-platform mobile or v0.1 release claims require this iOS gate
and SDK G0-I–G5-I; Android evidence is never treated as an inferred iOS pass.

Node-initiated requests for additional journal context or device capabilities
are post-AJ-RI future work and require separate SDK protocol plus AJ
UX/security decisions. They are not an implied AJ-RI deliverable.

## 7. Required validation dimensions

- **Unit:** domain invariants, reducers/view models, state machines, validators,
  repositories, key policy, and error mapping with fakes.
- **Smoke:** clean build/install, lock/unlock, create/open entry, restart, SDK version.
- **Integration:** real DB/files, native audio, packaged SDK, bindings, node transport.
- **Recovery:** process death and injected failure at every recording/migration/delete transition.
- **Security/privacy:** credential/content leakage, key invalidation, malformed AI,
  pairing adversaries, permissions, backups, snapshots, and logs.
- **Performance:** capture-start latency, first transcript text, frame backlog, DB
  write cost, long-session memory, playback, organization first event/total time,
  battery, storage growth, and thermal behavior.

## 8. Pre-implementation approval checklist

- [x] Database and recording encryption/key ADR accepted (ADR-017).
- [x] PIN KDF (Argon2id), retry/backoff, biometric dual-wrap/invalidation, and
      reset semantics accepted (ADR-017).
- [x] Recording format/library, interruptions, duration, and storage limits
      accepted for Android (ADR-017).
- [x] Portable backup envelope cryptography and restore activation accepted (ADR-017).
- [x] AJB1 binary layout, canonicalization, and vectors frozen for implementation
      (2026-10-10; backup-and-restore.md §9). iOS cross-platform evidence pending.
- [ ] Argon2id parameters benchmarked on the lowest-supported **physical** Android device
      (no device available as of 2026-10-10; the emulator is not a substitute).
- [x] Transcription engine boundary re-decided: SDK-owned, on-device
      `audio.transcribe@1` (ADR-021); migration is AJ-RI-2.
- [ ] Live-transcription window/overlap/cadence frozen from device measurements
      (live UX approved, ADR-017).
- [x] `journal.organize@1` contract ownership decided (ADR-018/019) and runtime
      ownership superseded by ADR-021; contract,
      schemas, and vectors frozen in AJ-2.0 (ADR-019, `journal-organize.md`),
      with open questions O-1 to O-7 listed there.
- [x] Android minimum API 26 reconciled with the SDK; compile API 36 is required
      by React Native 0.87 while target API remains 35.
- [ ] iOS minimum version reconciled and built on macOS/Xcode.
