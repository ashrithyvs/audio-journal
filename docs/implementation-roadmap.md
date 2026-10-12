# Implementation Roadmap

**Status:** Target staged plan. AJ-0 is in progress; see
`validation/AJ0-progress.md` for the current gate evidence.

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
- Integrate the app-owned on-device transcription engine (ADR-016) with
  independent cancellation.
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
AJ-1 is provisionally complete on emulator evidence, not accepted: the
physical-device, live-timing, and iOS gates stay deferred. AJ-2.0 and AJ-2.1
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

**Status (2026-10-12): accepted for the Android-first profile and merged
into `main`** ([AJ-2 progress §11](validation/AJ2-progress.md#11-android-first-aj-2-acceptance-2026-10-12)).
The acceptance covers AJ-2.0 to AJ-2.2 on the deterministic `aj.rules`
baseline, and SDK-AJ-5 is closed on SDK `c4b302e` (merged as `855edaf`).
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

## 6. AJ-4 — Hardening and release acceptance

- Exercise `local`, `node`, and `auto` modes and privacy-safe developer diagnostics.
- Test long recordings, repeated sessions, lifecycle transitions, interruptions,
  cancellation races, low storage, memory pressure, key invalidation, and migration.
- Run dependency/privacy review and plaintext-at-rest/log/backup inspection.
- Produce tester guide, fixture media, supported-device matrix, and baselines.
- Rerun the [organize performance suite](validation/AJ2-organize-performance.md)
  cumulatively. It covers `journal.organize@1` through the public SDK, cold
  and warm, from 30 s to 60 min transcripts and at the exact boundaries.
  Repeat its accepted matrix on physical Android hardware. It stays separate
  from the transcription benchmarks and the SDK capability load lab.

Exit: Android and iOS journeys pass on the frozen matrix, with results attached
to the Hybrid AI SDK release evidence where required.

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
- [x] Transcription engine boundary decided: app-owned, on-device (ADR-016).
- [ ] Live-transcription window/overlap/cadence frozen from device measurements
      (live UX approved, ADR-017).
- [x] `journal.organize@1` ownership and runtime decided (ADR-018); contract,
      schemas, and vectors frozen in AJ-2.0 (ADR-019, `journal-organize.md`),
      with open questions O-1 to O-7 listed there.
- [x] Android minimum API 26 reconciled with the SDK; compile API 36 is required
      by React Native 0.87 while target API remains 35.
- [ ] iOS minimum version reconciled and built on macOS/Xcode.
