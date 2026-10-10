# AJ-1 Progress Validation (checkpoint 3)

**Date:** 2026-10-10
**Status:** AJ-1's Android implementation is **provisionally complete on
emulator evidence**: every AJ-1 feature is implemented on `aj1/domain-core`
and has passed host tests and emulator device journeys. AJ-1 is **not
accepted**:

- the physical-device gates (Argon2id parameters, memory/latency, the AJB1
  production profile) are deferred, not passed;
- iOS is deferred, not passed (no macOS/Xcode evidence);
- the live-text parameters stay PROVISIONAL (Open decision 3).

The AJ-3 S00–S19 merge gate **passed 20/20** on the final AJ-1 APK
(§0.2). The branch is not merged and not pushed; the merge waits for the
owner.

## 0. Checkpoint 3 summary

**Owner decisions applied (2026-10-10 afternoon).** These are in ADR-017
"Owner decisions of 2026-10-10", backup-and-restore §2/§9.10, ux-design,
LLD §8.1/§9/§13.1, security §12, and scope §4:

- the lock grace;
- a damaged backup stops, then needs an explicit skip
  (`AJ1-DEC-001` option B);
- restore needs the current PIN;
- the "empty journal" rule;
- the three-word recovery-key challenge;
- interrupted captures are kept;
- final passes restart after unlock.

**Commits on `aj1/domain-core`** (after `dc300cd`, `0ced9a6`, `72ee323`):

- `45bc02a`: native capture, playback, and transcription from AJR1, startup
  reconciliation, and the lock grace;
- `f2a0d38`: AJB1 encrypted export and restore with the backup UI;
- `e632240`: biometric availability after setup, scrollable Settings, the
  node notice (AJ-3 F3), and setup copy;
- `6f2b36b`: the AJ-1 device journeys and the no-idle hierarchy reader;
- this report and the owner-decision docs follow in the next commit.

Each commit was checked out in a clean worktree and passed typecheck and
Jest (343, 358, 360, and 360 tests); the first two also passed the JVM tests
(44 and 58), and `6f2b36b` passed `npm run test:baseline`.

**Defects found by the emulator journeys and fixed in this checkpoint:**

- A fresh install never offered biometric unlock until the app restarted:
  first-run setup bootstraps with no vault to probe, and nothing re-read the
  biometric state. It is now re-read after setup and after each unlock
  (LLD §8.1).
- Settings did not scroll, so "Lock now" was unreachable once biometric
  unlock was offered.
- whisper.cpp's non-speech annotations (`[BLANK_AUDIO]`, `[ Silence ]`)
  appeared as transcript lines. Annotation-only segments are now dropped
  (LLD §6); a silent recording reads "No speech was found".
- The restore preview read "1 entries" and "1 KB of audio" for a backup with
  no recordings.
- Provisional transcript rows repeated one testID per live window.

**Harness changes (not product changes):** the shared driver's
`uiautomator dump` never returns on a screen that ticks every second (the
recording timer, the playback position), so the AJ-1 journeys read those
screens through `e2e/aj1/tools/LiveDump.java` (LLD §12). The first capture
attempt failed for that reason only: the recorder had run for 12 minutes.

## 0.1 Validation

**Host:** Linux 7.0.0-38, Intel Core Ultra 7 155U, Node 22.22.1, JDK 17.0.20.

**Emulator:** `emulator-5554`, AVD `aj-api35-4g`, Android 15 (API 35),
x86_64, headless (`-no-window -no-audio`). Every device run held
`.aj-exclusive-run`, adb was pinned with `ANDROID_SERIAL`, and nothing else
ran on the host during the load runs.

**Release APK under test:** `app-release-aj1wt-be5a026d.apk`,
SHA-256 `be5a026df473da713a9c1897fea2e6717e80e4a78fe9793afbbf7df1e755bb66`,
built from the worktree content committed in this checkpoint.
**Final AJ-1 APK (for the AJ-3 regression):**
`/home/igdclt0603/Desktop/Ash/aj1-artifacts/app-release-6f2b36b.apk`,
SHA-256 `cb4ff897c085e3aef2364c760c1c243df35258a0794b7ed7e0b9f3fa477f4b7d`,
built from a clean checkout of `6f2b36b`. It differs from `be5a026d` only in
12 native libraries, whose assertion strings embed the absolute build path;
the dex, JS bundle, assets, and manifest are byte-identical. Smoke 7/7 and
capture 6/6 were re-run on it (`6f2b36b-clean/`).

Evidence: `/home/igdclt0603/Desktop/Ash/aj1-artifacts/evidence/device-aj1-wt-20261010/`
(`be5a026d/` for the final runs; earlier APKs' logs are kept beside it).

| Check | Command | Result |
|---|---|---|
| JS baseline | `npm run test:baseline` | Pass: format, typecheck, lint with 0 warnings, unit 233/233, smoke 3/3, integration 118/118, performance 6/6 (360 tests) |
| JVM tests | `./gradlew :app:testDebugUnitTest` | 58/58, including `Ajb1VectorsTest` 5/5 (all 4 valid archives rebuild byte for byte; all 71 hostile vectors fail with the reference code and stage), `BackupCodecTest` 4/4 (the production exporter reproduces the reference archive), and `RestoreActivationTest` 5/5 |
| Instrumented tests | `ANDROID_SERIAL=emulator-5554 ./gradlew :app:connectedDebugAndroidTest` | App 6/6: `VaultDeviceTest` 5/5 (SQLCipher at rest, Keystore sealing and tampering, libargon2 against the cross-checked tag, absurd memory refused, PIN lifecycle) and `RecordingSpeechDeviceTest` 1/1. The packaged SDK module's own tests also ran: 18, 0 failures, 6 skipped. |
| Speech from AJR1 | `ANDROID_SERIAL=emulator-5554 node e2e/aj1/speech.mjs` | 1/1 in 15.7 s: whisper.cpp's public-domain `jfk.wav` (SHA-256 `59dfb9a4…860e`, from the pinned whisper.cpp source) is sealed into AJR1 in 1 s chunks, then read back by the production `RecordingPass` into the bundled `base.en-q5_1` model. One 5-minute window yields "ask not what your country can do for you … what you can do for your country"; a 6 s window forces a cut inside the speech and the words survive it. |
| Smoke | `node e2e/aj1/smoke.mjs <apk>` | 7/7 |
| Capture | `node e2e/aj1/capture.mjs <apk>` | 6/6 |
| Backup and restore | `node e2e/aj1/backup.mjs <apk>` | 8/8 |
| Biometric | `node e2e/aj1/biometric.mjs <apk>` | 5/5 |
| Load, repeated | `node e2e/aj1/load.mjs <apk> --sessions 5 --minutes 1 --fresh` | 5/5 sessions |
| Load, long | `node e2e/aj1/load.mjs <apk> --sessions 1 --minutes 10` | 1/1 session |

**Capture (6/6).** Record 12 s with a pause that does not advance the
timer; play the sealed recording; the final pass settles; leaving the app
mid-capture seals and locks, and the next unlock shows a ready
"recovered" entry; discard asks first and leaves no entry.

**Backup and restore (8/8).** A written entry and a 6 s voice entry; a
backup protected by a recovery key confirmed with the three-word challenge;
saved through DocumentsUI and verified (`AudioJournal-2026-10-10-2057.ajbackup`,
not "incomplete"); app data cleared and a new journal with a new PIN;
restored through DocumentsUI (preview "2 entries · 1 recording · 203 KB of
audio"), activated with the current PIN, and locked; the restored written
entry shows and the restored recording plays; the old PIN is refused.

**Biometric (5/5).** A device PIN and an emulated fingerprint enrolled
through Settings; a journal with an entry; biometric unlock turned on
through `BiometricPrompt` with a `CryptoObject`; lock, then unlock with the
fingerprint; a second enrollment invalidates the biometric key, the PIN
still opens the journal with its entry, and Settings shows the
invalidation notice with biometric unlock off.

**Load (emulator development measurements, not budgets).** RSS is read from
`/proc`; the final pass is timed from Finish until the transcript section
reports a final or empty result.

| Session | Captured | Finish | Final pass after Finish | RSS start → peak → after pass |
|---|---|---|---|---|
| Repeated 1 | 61 s | 2.6 s | 18.1 s | 306 → 357 → 369 MB |
| Repeated 2 | 61 s | 2.6 s | 25.0 s | 372 → 372 → 456 MB |
| Repeated 3 | 61 s | 2.5 s | 24.0 s | 458 → 458 → 453 MB |
| Repeated 4 | 61 s | 2.6 s | 23.7 s | 456 → 463 → 458 MB |
| Repeated 5 | 61 s | 2.6 s | 23.9 s | 461 → 461 → 461 MB |
| Long | 601 s | 2.7 s | 105.7 s (two 5-minute windows) | 468 → 468 → 505 MB |

RSS levels off after the second session (models and decoder state stay
loaded); it does not grow across sessions. Battery temperature stayed at
25 °C (emulated). Every pass was "empty" because the emulator's microphone
is silent. An earlier load run timed the live draft by mistake (its rows
also use `transcript-line-*`); those numbers were discarded and the
journeys now wait on `transcript-kind-*`.

**Emulator limits.** `-no-audio` feeds the microphone silence, so capture
journeys exercise the full path but never real speech; the speech check
above covers real speech through AJR1 and the production windowing instead.
None of these numbers is a budget, and none stands in for the physical
device gates.

## 0.2 Exit-gate status

| AJ-1 requirement | Status |
|---|---|
| Encrypted SQLite and migrations | **Done** (emulator). Migration 2 adds `transcript_passes`. |
| Vault, persistent PIN, independent PIN and biometric copies | **Done** (emulator), including `BiometricPrompt` enable, fingerprint unlock, and invalidation by a new enrollment with the PIN still opening the journal. |
| Argon2id parameters, memory/latency acceptance, AJB1 production profile | **Deferred.** They need the lowest-supported **physical** Android device. Not waived and not reported as passed. |
| AJR1 capture, pause/resume, interruption, playback | **Done** (emulator). |
| whisper.cpp on decrypted AJR1 PCM; live provisional text | **Done** (emulator). Live window, overlap, and cadence stay PROVISIONAL until measured on a physical device (Open decision 3). |
| Entries, timeline, detail, correction | **Done** for written and voice entries. |
| Startup reconciliation and storage pressure | **Done** (host and emulator interruption journey). |
| AJB1 backup and restore | **Done** (JVM vectors and emulator journey), with the owner decisions. |
| Device load and performance | **Emulator measurements recorded** (§0.1); physical-device numbers deferred. |
| iOS | **Deferred.** No evidence; needs macOS and Xcode. |
| AJ-3 S00–S19 on the final AJ-1 APK (merge gate) | **Passed 20/20**: `app-release-6f2b36b.apk` (SHA-256 `cb4ff897…4b7d`), one fresh run (attempt 1, nothing resumed) with `--expect-persistent-pin` on `emulator-5556`, harness `84d3b4c`, 23:18–23:58 IST, by `hybridai-7b`. Evidence: `audio-journal/e2e/speech/results/aj3-final-6f2b36b/report.json` (`counts: pass 20, fail 0`). Report: `docs/validation/AJ3-android.md` §8.3 on `main`. |

---

## Checkpoint 2 (kept for history)

**Date:** 2026-10-10
**Status:** AJ-1 is **not complete**, so its exit gate is not met and AJ-2
has not started. The native recorder, playback, transcription on recordings,
and the AJB1 production codec are still to be built (§3).

**Code under test:**

- Branch `aj1/domain-core`, worktree `../audio-journal-aj1`, based on `main`
  at `6383209` (after the speech/performance handoff).
- Commits:
  - `0876d7d`: domain, schema, repositories, and live-text retention;
  - `d7109bc`: controller and screens;
  - `088977c`: host tests;
  - `82f0e4c`: bidi-control escape fix and guard.
- The work in §1.2 is committed with this report.

**Hybrid AI SDK:** the packaged `0.1.0-m5` from `e0fc3c5` (ADR-015). AJ-1
neither uses nor changes it.

**Owner decisions applied (2026-10-10):**

- the AJ-1 track is the sole owner of the native layer;
- storage thresholds are MiB;
- discards are tombstoned;
- superseded live rows are kept, frozen, hidden, and bounded at 4 000;
- AJR1 per-recording keys and indexed frames;
- AJB1 §9 frozen for implementation once its conditions passed;
- the physical-device gates are deferred, not waived;
- AJ-1's exit gate is its own suites. AJ-3 S00–S19 is a merge gate, not part
  of AJ-1's exit gate (roadmap §3);
- the node companion stays in this repository as `node-companion/`, a
  separate deployable (ADR-018 clarified).

## 1. Implemented

### 1.1 Earlier checkpoint (committed)

- **Domain:** recording state machine, transcript revisions and corrections,
  live-text rules, PIN attempt policy, reconciliation, timeline and
  validators, backup inventory checks.
- **Storage:** schema v1 with constraints and immutability triggers,
  migrations, repositories.
- **Screens:** Diary, Write, Entry detail, Recording.

### 1.2 This checkpoint

| Area | What exists |
|---|---|
| Native vault | Pure-Kotlin `Vault`:<br>- independent PIN and biometric copies of MK<br>- a device-sealed `AJV1` record<br>- the persisted attempt policy, clock-rollback safe<br>- atomic writes; rewrap when parameters change; fail closed on tampering<br>Production adapters: Keystore sealer, `BIOMETRIC_STRONG` `CryptoObject` key, libargon2 20190702 JNI (`android/vault-crypto`, archive SHA-256 pinned). |
| Encrypted store | SQLCipher 4.19.1 keyed natively with the raw `HKDF(MK, "aj-db-v1")` key, WAL, all work on one thread; JSON TurboModule; `SerialSqlDatabase` shared with tests |
| Lock and journal wiring | AJ-0 volatile scaffolds removed. Lock runs over `VaultService`: lockout text, biometric invalidation falls back to the PIN, each lock zeroes MK and closes the database, Erase journal needs the typed word ERASE, Settings has a biometric toggle. `JournalGate` opens, migrates, and reconciles after unlock. The Diary tab has a journal stack. |
| AJR1 codec | Per-recording `HKDF` keys, indexed and authenticated frames, strict ordering (gaps allowed), torn-tail index skipping, overflow refusal, streaming reads |
| AJB1 | §9 frozen for implementation. Independent reference, 43 vector files, a Python verifier, and the export/restore cancellation procedure. |

## 2. Validation

**Host:** Linux 7.0.0-38, Intel Core Ultra 7 155U (14 CPUs), Node 22.22.1,
Python 3.14.4 with `cryptography` 46.0.5.

**Emulator:** `emulator-5554`, AVD `aj-api35-4g`, Android 15 (API 35),
x86_64. Every run held `.aj-exclusive-run`, and adb was pinned with
`ANDROID_SERIAL`. The peer's functional suite ran on `emulator-5556` in
parallel; there were no benchmarks.

| Check | Command | Result |
|---|---|---|
| JS baseline | `npm run test:baseline` | Pass: format, typecheck, lint with 0 warnings, unit 195/195, smoke 3/3, integration 79/79, performance 6/6 |
| AJB1 vectors reproduce | `node tools/ajb1-reference/generate-vectors.mjs --check` | 43 files, 0 mismatches |
| Reference tool tests | `node --test tools/ajb1-reference/test/*.test.mjs` | 27/27, including RFC 9106 Argon2d/i/id, BLAKE2b, BIP-39 known answers, canonical JSON, and procedure cancellation and cleanup (7) |
| Independent AJB1 verifier | `python3 -I tools/ajb1-reference/verify_vectors.py schemas/ajb1/v1` | 81 vectors: same verdicts, and OpenSSL Argon2id reproduces every KEK |
| libargon2 host cross-check | `tools/ajb1-reference/crosscheck/crosscheck.sh <dir>` | Archive SHA-256 OK; 11/11 cases match the reference (p = 1–4) |
| AJR1 vectors reproduce | `node tools/ajb1-reference/generate-ajr1-vectors.mjs --check` | 10 files, 0 mismatches |
| JVM tests | `./gradlew :app:testDebugUnitTest` | 24/24: `VaultTest` 13, `Ajr1Test` 9, `Ajr1VectorsTest` 2 (the Kotlin codec rebuilds the Node files byte for byte) |
| Debug build | `./gradlew :app:assembleDebug` | `BUILD SUCCESSFUL` in 4 min 16 s. `libaj_argon2`, `libsqlcipher`, and `libaj_whisper` for arm64-v8a and x86_64. No warnings in AJ-1 Kotlin. |
| Device tests | `ANDROID_SERIAL=emulator-5554 ./gradlew :app:connectedDebugAndroidTest` | 5/5 (see below) |
| Release build | `./gradlew :app:assembleRelease` | `BUILD SUCCESSFUL` in 2 min 49 s; R8 |
| Device smoke | `ANDROID_SERIAL=emulator-5554 node e2e/aj1/smoke.mjs app-release.apk` | 7/7 (see below) |

**Device tests (5/5).**

- **Encryption at rest.** The database and WAL bytes contain neither the
  plaintext canary nor a SQLite header.
- **Wrong key.** A wrong raw key fails as "not a database".
- **Lock.** Locking closes the store.
- **Keystore sealing** round-trips and rejects tampering.
- **libargon2 on the device** equals the cross-checked tag.
- **Absurd memory** is refused without a crash.
- **PIN lifecycle** works with the real Keystore and Argon2id.

The first device run failed 1 of 5. Kotlin had passed an `Array` to
SQLCipher's Java varargs `rawQuery` unspread, so all parameterized reads
were broken; the wrong-key test would also have passed for the wrong
reason. Both were fixed, and the test now asserts the cause.

**Device smoke (7/7, release build).** Fresh install, PIN setup in the
native vault, write an entry into the encrypted store, lock, wrong-PIN
refusal, process death, then unlock to the persisted entry.

**Development measurements.** These are host or emulator numbers, not
budgets.

| Measurement | Value |
|---|---|
| Reference JS Argon2id, 19 MiB, t = 2, p = 1 (host) | 0.71 s |
| AJB1 vector generation (43 files, about 12 KDFs) | 10.3 s |
| Python verification of 81 vectors | 2.3 s |

## 3. Exit-gate status

| AJ-1 requirement | Status |
|---|---|
| Encrypted SQLite and migrations | **Done.** Host, emulator, and device smoke pass. |
| Vault, persistent PIN, independent PIN and biometric copies | **Done** on the emulator. The `BiometricPrompt` flow has no test yet. It **can** run on the emulator with an enrolled fingerprint, so it is scheduled, not deferred (roadmap §3, step 6). |
| Argon2id parameters, memory/latency acceptance, AJB1 production profile | **Deferred.** They need the lowest-supported **physical** Android device, and none is available. Not waived and not reported as passed. |
| AJR1 container | **Codec done** (JVM and cross-implementation). Next: native `AudioRecord` writer, playback, and pause, resume, and interruption handling. |
| whisper.cpp on decrypted AJR1 PCM; live provisional text | **Not started.** The port change is next; window parameters stay Open. |
| Entries, timeline, detail, correction | Written entries pass end to end on the device. Voice entries wait for the recorder. |
| Startup reconciliation and storage pressure | Domain done; the native scan and free-space probes come with the recorder. |
| AJB1 backup and restore | Format frozen; production codec and UI are next. |
| Device load and performance (long recordings, repeated sessions, RTF, RSS, thermal) | After the recorder; in exclusive runs. |
| iOS | No evidence. Needs macOS and Xcode. |

**AJ-3 compatibility (merge gate).** The AJ-3 track has an interim S00–S19
run going against `app-release-94604ca.apk` on `emulator-5556`, writing to
a new evidence directory:

- SHA-256 `98d3ee40a87a6f928b703acc17c043523fe786247d6dabb85b54760482b3d1ab`;
- built from the content committed at `94604ca`.

The APK has no recording, playback, backup, or recording-based
transcription, so the full suite runs again against the final AJ-1 APK.
