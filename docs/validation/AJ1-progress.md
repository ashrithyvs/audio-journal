# AJ-1 Progress Validation (checkpoint 2)

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
