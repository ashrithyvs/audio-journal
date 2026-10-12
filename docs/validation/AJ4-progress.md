# AJ-4 Progress: AJ-4-E (Android Emulator-Validated Development Profile)

**Branch:** `aj4/hardening` (worktree `../audio-journal-aj4`), from `main`
`59339e9`. It is not merged, pushed, or released.

**Status:** AJ-4.0, the scope and gap freeze, is in progress. AJ-4-E is not
accepted. Canonical AJ-4 and release acceptance stay open.

## 1. Authorization and scope

The owner authorized AJ-4-E on 2026-10-12. It is an Android emulator-validated
development profile. **It is not canonical AJ-4, not release acceptance, and
not cross-platform.** Physical Android and all iOS testing are **deferred,
not waived**. Canonical AJ-4 depends on them (roadmap §6.1).

**Milestone records at the start of AJ-4:**

| Milestone | Status |
|---|---|
| AJ-1 | Accepted for the Android-emulator development profile ([AJ-1 progress](AJ1-progress.md)). Physical-device Argon2id, real-microphone, performance, thermal/battery, and iOS gates stay open |
| AJ-2 | Accepted for the Android-first profile ([AJ-2 progress §11](AJ2-progress.md#11-android-first-aj-2-acceptance-2026-10-12)) |
| AJ-3 | Accepted for the Android-emulator development profile ([AJ-3 Android](AJ3-android.md)). Physical-network, physical-device, and iOS gates stay open |

**Accepted baselines:**

| Item | Value |
|---|---|
| Audio Journal `main` | `59339e9` |
| Hybrid AI SDK `main` | `59b2cd8` (SDK-AJ-5 merge `855edaf`) |
| Packaged SDK source | `c4b302e` |
| AAR SHA-256 | `8751a5a7623a2c6ea5a75216afd410d9483410da3c9f96f4c4527c852da86b1a` |
| RN tarball SHA-256 | `a11cba67036d6e38662e6485c75d891dfc0110ebc41cd05aa7ea8f870c14ee2a` |

The SDK repository stays read-only.

## 2. Objective

The goal is a feature-complete, installable Android build that a tester can
use with the packaged Hybrid AI SDK and the separate node companion. It is
validated comprehensively on Android emulators. Emulator development
baselines are kept apart from future physical-device results.

## 3. Boundaries (unchanged)

- `Capability` remains the SDK abstraction. There are no SDK-private
  imports and no SDK source changes.
- Audio and transcription are app-owned and on-device (ADR-016).
- Organization is node-only in v1, through `journal.organize@1` and the
  public SDK only.
- `aj.rules` is a deterministic functional implementation and performance
  baseline. It is not model-backed inference or quality.
- There is no cloud, relay, storage service, marketplace, distributed
  compute, or app-specific code in the SDK.
- O-4 to O-7 are not expanded silently. They stay as recorded in
  `journal-organize.md` §12.

## 4. Required functional journeys

1. Clean installation, onboarding, persistent PIN, relock, and biometric
   simulation.
2. Written and voice journal creation.
3. Pause, resume, interruption, and recovery.
4. Encrypted recording playback.
5. The final on-device transcription, and correction.
6. Diary and entry-detail navigation.
7. Node discovery, pairing, verification, reconnect, revocation, forget, and
   re-pair.
8. Explicit consent before organization.
9. `journal.organize@1` only through the public SDK.
10. Organized, History, and Tasks, with due dates, stale sources, task-state
    carry-over, the partial-result warning, and navigation to the source and
    its audio range.
11. Cancellation, deadlines, retry, and node unavailability.
12. Encrypted backup export and empty-vault restore.
13. Lock, process death, and restart behavior.
14. Complete offline journal use when no node exists.

## 5. Validation matrix

1. Unit and contract tests.
2. Component smoke tests.
3. Integration tests with the real encrypted DB and files, the SDK package,
   and the node companion.
4. **Recovery:**
   - process death;
   - lock and background transitions;
   - recording interruption and torn-tail recovery;
   - node restart and network loss;
   - cancellation and deadline races;
   - backup and restore interruption;
   - injected database migration failure.
5. **Privacy and security:**
   - no journal text, transcript, PIN, pairing payload, or key material in
     product logs;
   - the encrypted database and recordings at rest;
   - backup authentication and hostile-archive rejection;
   - malformed or hostile node results, and provenance escapes;
   - `FLAG_SECURE`, the app lock, and clipboard and snapshot behavior;
   - harness failure messages that never echo user content.
6. **Load and soak:**
   - repeated recording and transcription sessions;
   - repeated organization, with task and history revisions;
   - SDK and node concurrency, and cancellation;
   - reconnect loops;
   - database growth and bounded memory;
   - at least one extended emulator soak, with its final results collected.
7. **Performance on the API 35 emulator:**
   - cold and warm launch;
   - capture-start and playback latency;
   - transcription RTF and time to the final transcript;
   - organization timings: accepted, first progress, first partial,
     completion, and on screen;
   - the 30-second to 60-minute organization matrix;
   - CPU, RSS, storage growth, and network bytes;
   - cancellation and deadline latency;
   - p50, p95, and variance.
8. **Compatibility:**
   - primary: API 35 x86_64;
   - API 26 and API 28 functional, pairing, and organization smoke;
   - an `arm64-v8a` release build with package-content verification
     (build only).
9. A fresh, final, cumulative AJ-3 S00–S19 against the AJ-4-E release APK.
10. A privacy scan over all accepted logs and evidence.

## 6. What AJ-4-E may and may not accept

**May accept:** documented minor UI defects, and emulator-specific variance.

**Must not accept:**

- data loss or source mutation;
- plaintext journal text or audio at rest;
- secrets or journal content in logs;
- a broken lock or broken backup authentication;
- invalid provenance;
- silent partial or truncated organization;
- explicit-target routing violations;
- duplicate or missing terminal events;
- a broken core tester journey.

## 7. Deliverables

- An installable release APK with `x86_64` and `arm64-v8a`, its SHA-256,
  and verification of the embedded SDK core.
- Instructions to start and pair the node companion.
- An Android tester guide: install, journal creation, transcription,
  pairing, organization, tasks, backup, and recovery.
- Fixture and test-data instructions.
- The supported and emulated API matrix.
- A consolidated AJ-4-E validation report.
- A list of known issues and deferred gates.
- A performance report, labelled as an emulator development baseline.
- A physical Android test plan, ready to run when hardware arrives.
- An iOS catch-up plan, aligned with the SDK's deferred G0-I to G5-I.

## 8. Gap freeze (AJ-4.0)

Pending: the inventory of existing coverage against §4 and §5.
