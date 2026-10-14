# AJ-RI-2 — Static transcription through the packaged Hybrid AI SDK

**Status:** ACCEPTED at `09e3580` (`AJ-RI-2-REV-1`, 2026-10-15): both Audio
Journal GRI-2 rows pass, and full `GRI-2` is accepted for the Android-emulator
development profile. Physical Android, iOS, thermal/battery, a larger journal
corpus, and release packaging remain deferred (not blockers); live
transcription remains stopped. Not merged or pushed: the AJ merge is a
separate action that needs the owner's instruction.
**Branch:** `aj-ri2/static-transcription` from `main@837a77b`.
**Gate:** the two Audio Journal rows of SDK `GRI-2` (RI-2 record §13/§16):

1. Audio Journal invokes static transcription only through the public Hybrid
   AI SDK, and no longer links or invokes its own model runtime.
2. Recordings stay durable and recoverable across provider failure,
   cancellation, app lock, and process death, without plaintext leakage or
   data loss.

Full `GRI-2` acceptance is Codex's decision; this record does not claim it.

## 1. Accepted inputs (verified, no substitution)

| Item | Identity | Verified |
|---|---|---|
| Packaged SDK (Android AAR, debug) | `hybrid-ai-android-debug.aar`, SHA-256 `c336b93a181a5dc2982c9e2667b264dbf42d3871ac6a6540287c1bd70c528a49` (RI-2 `a54266a`, built from `27843f8`) | verified 2026-10-15 |
| Model artifact | `ggml-tiny.en-q5_1.bin`, 32,166,155 bytes, SHA-256 `c77c5766f1cef09b6b7d47f21b546cbddd4157886b3b5d6d4f709e91e66c7c2b` | verified 2026-10-15 |
| Profile | `sdk.whisper.tiny-en-q5-1@1.0.0`, document SHA-256 `5d722be29fe7feae78c7880f12f7e6eae35458e9237753941a3c7d7e54a4e50b` | verified 2026-10-15 |
| Capability package | `sdk.audio-transcribe.tiny-en@1.0.0` for `audio.transcribe@1.0.0`, document SHA-256 `f2f59c4d576acae207646a67b556123c3057c9798a5b97c388b9bef152696544` | verified 2026-10-15 |
| Provider / decode | `whisper.cpp v1.9.5+d1be6fde.ri2-decode.1` / `ri2-decode.1` | verified 2026-10-15 |
| Shared spine | `ri/shared-spine@eca92dc` | (SDK-side) |

Exact copies with `SHA256SUMS` live in `Ash/hybrid-ai-packages/ri2-a54266a/`
(the AAR and model copied from `Ash/ri2-evidence`, the documents from
`git show a54266a:core/providers/transcription/model-pack/<file>`).

## 2. Decisions applied

- `AJ-RI2-DEC-001` (Codex Option A): no provisional live text in this
  candidate; one static SDK transcription after Finish. ADR-022,
  `ri2-transcription-consumer.md`, and `real-inference-migration.md` amended.
- `AJ-RI2-DEC-002` (Codex Option A): the exact RI-2 debug AAR for every AJ
  variant and path in this development branch, with a focused organize/node
  regression. All measurements are development evidence.
- `AJ-RI2-DEC-003` (Option A): the SDK's queued pull methods (`prepare`,
  `runQueued`, `nextEvent`, `cancel`, `close`) are an intentionally public
  execution surface; using them is required to observe the request's
  terminal before the audio source is released.

## 3. Implementation

Boundaries: Audio Journal owns capture, AJR1 storage, keys, journal state,
validation, persistence, and UI; the SDK owns the model, inference, events,
cancellation, and model lifecycle. No SDK file was changed from this lane.

- **Removed (GRI-2 row 2):** `android/speech-engine` (whisper.cpp JNI,
  `libaj_whisper`), `WhisperNative`, `SpeechModels`, `RecordingPass`,
  `LiveTranscriber`, `Wav`, their tests and ProGuard rules; the Gradle task
  that downloaded `ggml-base.en`/`ggml-tiny.en` from Hugging Face; the JS live
  and evaluation adapters (`NativeLiveTranscriber`,
  `NativeTranscriptionService`, `TranscriptionService`, `wordErrorRate`) and
  the Load Lab speech plan. Upgraded installs delete the old engine's model
  copies (`no_backup/speech-models`) before the first SDK request.
- **Model pack:** `provisionTranscriptionPack` copies the three pinned files
  from `hybridAi.transcriptionPackDir` into APK assets, failing the build on
  any missing file, size, or SHA-256 difference (nothing is downloaded).
  `TranscriptionPack` re-verifies on device (documents by exact SHA-256 and
  stated identity, model by size and SHA-256), installs the model into
  `no_backup/hybrid-ai-transcription/`, and builds the creation-time
  `ModelRuntimeConfiguration`; any mismatch fails closed
  (`MODEL_PACK_INVALID`).
- **Public SDK only:** `SdkTranscriptionEngine` uses `NativeHybridAIClient(
  context, modelConfiguration)`, `registerAudioSource(source,
  "audio.transcribe", 1)`, and the public queued pull execution that
  `stream()` is built on (`prepare`, `runQueued` producer, `nextEvent`
  consumer, `cancel`; RI-SHARED-DEC-001 S6) with `ExecutionTarget.LOCAL`
  (never node or auto). Holding the operation lets a cancel observe the
  request's own terminal. `modelProfiles()` supplies the model-lease count.
- **Bounded AJR1 adapter:** `Ajr1PcmSource` implements `PcmAudioSource` over
  the read-only `Ajr1Reader`: each SDK read decrypts only the frames its span
  touches straight into the SDK buffer (frame plaintext zeroed after each
  copy); no plaintext file. `close()` zeroes the recording key; an
  authentication failure yields `FAILED` and `SOURCE_DAMAGED`. Audio, paths,
  and keys never cross JavaScript, JSON, logs, or the node protocol.
- **Refusals before SDK work:** recording still capturing
  (`RECORDING_NOT_SEALED`), missing (`RECORDING_MISSING`), locked (`LOCKED`),
  empty, or over 2,880,000 frames (`UNSUPPORTED_DURATION`, never truncated;
  JS shows a typed "longer than 3 minutes" state and never sends it).
- **Event contract:** `TranscriptionEvents` requires `accepted` first and
  exactly one terminal; later events are counted and ignored. A `completed`
  result is stored only if `audioMs` equals the source, the model is the
  pinned profile/version/artifact, indexes are contiguous, spans ordered and
  in bounds, text non-empty, and the final segments equal the delivered
  partials; otherwise `INVALID_RESULT`.
- **Lifecycle (`RecordingTranscriptions`):** user cancel and app lock call
  the SDK operation's `cancel()`, keep pulling until that operation's own
  single terminal (`cancelled`) arrives, join its producer (bounded 3 s), and
  wait for its model lease to be released (inference has left the model;
  bounded 3 s); only then is the registration (and with it the source and
  key) closed. The vault's lock/erase/restore path calls
  `RecordingJobs.cancelAll()` before the journal closes and keys are zeroed;
  it waits at most 3 s in total for every request to finish that sequence and
  otherwise closes the registration itself. From that call on, new requests
  are refused (`LOCKED`) until the vault's unlock epoch rises, also when no
  transcription had run yet in the process, so no request can start in the
  lock window. A request whose stream stalls past the SDK deadline plus 10 s
  is cancelled by a watchdog and reported as `TRANSCRIPTION_TIMEOUT`. A cancel that arrives before its request started is
  remembered; JS request IDs are unique per process. The client survives a
  lock (it holds no key or audio) and is closed only on module teardown,
  after cancellation. A cancelled or locked request never yields a stored
  transcript, even if the SDK raced to `completed` (enforced natively and in
  JS). Each job keeps a content-free step trace for evidence.
- **Persistence (JS):** `TranscriptionController` stores a revision only for a
  validated `ok` result while the journal is open; failures and cancels leave
  the recording and transcript unchanged; automatic requests never loop on a
  failure; the user can retry every recoverable outcome; after process death
  the next unlock re-queues recordings without a full pass. Stored model ID:
  `sdk.whisper.tiny-en-q5-1_1.0.0` (the store and AJB1 grammar forbid `@`; the
  new durability integration test caught this before any device run).
- **Live text:** none (`AJ-RI2-DEC-001`); the dormant live controller is not
  wired.

## 4. Evidence

Evidence class `REAL_MODEL_PUBLIC_SDK` (the packaged AAR and real model on the
API 35 emulator `aj-api35-4g`, `sdk_phone64_x86_64` 15/`AE3A.240806.019`,
4 vCPU, 4 GiB; one emulator, exclusive lock). x86_64 emulator figures are
development measurements only (`AJ-RI2-DEC-002`). Evidence lives in
`Ash/aj-ri2-evidence/` (stage logs, results, manifest `SHA256SUMS`); scripts in
its `tools/`; manifest of 233 files, SHA-256
`aa47a56016187aa97ad7ce03863a53ba5cea404fd4ccaae3e6c12c24376d15b0`. Corpus: the pinned public LibriSpeech RI-2 corpus
(`Ash/ri2-evidence/corpus`, 12 clips of 29-180 s, WAV hashes checked before
use); transcripts appear only in evidence files, never in logs.

### 4.1 Final runs

Final code: native `002d96d` (harness `b2d8aa0`); stage 8
(`Ash/aj-ri2-evidence/stage8`, 04:18-04:38 IST), all steps exit 0. APKs:
debug `10e5d1b4…36d0`, androidTest `c8036732…7543`, e2e `6e6f4c00…32f6`.
Stage 8 reran what the re-review follow-ups (native only) affect; the JS gate,
voice-entry, and organize/node regressions ran on `fe7abfb` in stage 7 (§4.2,
§4.5) and nothing in JS or a shared app path changed after it.

| Check (stage 8) | Result |
|---|---|
| Pins (staged pack, `ri2-evidence` AAR/model, `git show a54266a` documents) | all match |
| Gradle JVM tests + debug/androidTest/e2e APKs | pass (speech 25 tests incl. the R1 and watchdog tests) |
| APK boundary | no app-owned Whisper/ggml or legacy model assets |
| `TranscriptionDurabilityDeviceTest` | **8/8** |
| t05 user cancel (180 s, 5 s in) | `cancelRequested@4999 → terminal:cancelled@5067 → producerEnded@5067 → leaseReleased@5067 → registrationClosed@5068 → sourceCloses:1` |
| t06 app lock (180 s, 5 s in) | `cancelAll()` returned in 51 ms: `cancelRequested@5000 → terminal:cancelled@5050 → producerEnded → leaseReleased@5051 → registrationClosed@5051 → sourceCloses:1`; next request `LOCKED`; after unlock `ok` |
| t03 provider failure / t04 model failure / t07 damaged | `DEADLINE_EXCEEDED` at 1,638 ms then retry `ok` / `MODEL_PACK_INVALID` then retry `ok` / `SOURCE_DAMAGED` |
| t08 storage scan (upgrade + seeded legacy model) | legacy `speech-models` removed; every file classified; nothing suspicious |
| WER (12 clips, two scorers agree) | **7.05% normalized / 7.43% raw** (30 s 6.02%, 60 s 8.23%, 180 s 6.84%) |
| Development timings | 30 s 3.4-6.3 s, 60 s 9.9-10.6 s, 180 s 28.5-31.9 s (RTF 0.12-0.21); first partial 3.2-6.7 s; peak RSS 379-381 / 419-433 / 468-483 MiB (app baseline 204 MiB) |
| `VaultDeviceTest` | pass |
| Instrumented-run logcat privacy scan | 2,579 transcript 4-word phrases, 0 hits; no path/key/WAV markers |
| UI journey | **J00-J07, J06 all pass** |
| J01 / J02 | 30 s and 60 s: Finish → final transcript 10.1 s / 13.2 s |
| J03 lock | 177 s recording; HOME during the pass locked the app; no transcript survived; after unlock the pass was queued again and completed 50.8 s after the lock |
| J04 process death | `kill -9` (root) during a 60 s pass; restart was locked; after unlock the recording was intact and the pass completed 29.7 s after the kill |
| J05 user cancel | Cancel during a 60 s pass stored nothing; Transcribe then completed |
| J07 over limit | 186 s recording: typed "longer than 3 minutes" state, never sent, no transcribe action, recording stays openable |
| J06 device-log privacy | 0 findings over 3.4 MB (no transcript phrase, path, key label, or WAV name); no buffer pruned |

**Gate rows.** Row 1: the APK links no app-owned runtime and transcription
uses only public SDK classes (boundary test, APK scan; the queued-pull surface accepted by
`AJ-RI2-DEC-003`). Row 2: the recording is never changed
by provider failure, model failure, damage, cancel, lock, or process death,
each is retryable, the lock cancels and observes the terminal before close,
and no plaintext audio or transcript reaches storage or logs.

### 4.2 Static and host checks (stage 7, `fe7abfb`)

| Check | Result |
|---|---|
| Pins: staged pack `SHA256SUMS`, model 32,166,155 bytes, AAR and model in `ri2-evidence`, profile/package `git show a54266a` | all match |
| `tsc --noEmit`, Prettier, ESLint | pass |
| Jest unit / integration / smoke | 313/313, 166/166, 3/3 |
| Gradle `testDebugUnitTest` (JVM) | all suites pass; speech: `Ajr1PcmSource` 3, `TranscriptionEvents` 5, `RecordingTranscriptions` 12, `TranscriptionPack` 3 (real staged bytes); vault, AJR1, backup unchanged and passing |
| APK boundary (debug and e2e) | no `libaj_whisper`, `libwhisper`, `libggml`, `speech-models`, or `ggml-base`; the only Whisper code is the SDK's `libhybrid_ai_whisper_transcription.so` (byte sizes identical to the AAR's); assets: the pinned pack under `hybrid-ai-transcription/` plus the SDK's legacy assets |
| `unit-tests/transcriptionBoundary.test.ts` | no app C/C++ besides `vault-crypto`, no runtime symbols or extra `loadLibrary`, no model download, pins identical in Gradle and Kotlin, only public `ai.hybrid.sdk` imports, LOCAL target only |

### 4.3 Device durability suite (`TranscriptionDurabilityDeviceTest`, stage 7)

8/8 on device (`OK (8 tests)`), production adapter, orchestration, and pack
over AJR1 recordings sealed from the corpus:

| Test | Result |
|---|---|
| t01 identity | profile `sdk.whisper.tiny-en-q5-1`, provider `v1.9.5+d1be6fde.ri2-decode.1`, artifact `c77c5766…7c2b`, installed model 32,166,155 bytes with the same SHA-256 |
| t02 accuracy (12 clips) | all `ok`; `audioMs` equals the source; recording bytes unchanged; source closed exactly once; 0 jobs, 0 leases after each |
| t03 provider failure | 1,500 ms deadline on 180 s: `DEADLINE_EXCEEDED` after 1,669 ms, no segments, source closed once, recording unchanged; retry `ok` |
| t04 model failure | one flipped byte in the model: `MODEL_PACK_INVALID`, key released, nothing installed; retry with the real pack `ok` |
| t05 user cancel (180 s, 5 s in) | `registered → cancelRequested@5000 → terminal:cancelled@5045 → producerEnded@5045 → leaseReleased@5046 → registrationClosed@5046 → sourceCloses:1`; recording unchanged; retry `ok` |
| t06 app lock (180 s, 5 s in) | `cancelAll()` returned in 90 ms: `cancelRequested@5000 → terminal:cancelled@5089 → producerEnded → leaseReleased@5090 → registrationClosed@5090 → sourceCloses:1`; next request `LOCKED` until unlock; after unlock `ok` |
| t07 damaged recording | one flipped ciphertext byte: `SOURCE_DAMAGED`, nothing stored, source closed once |
| t08 storage scan | after upgrading over pre-RI-2 data plus a seeded legacy model: legacy `speech-models` removed; every file classified (AJR1 13, SQLCipher 3, vault 1, verified model pack 1, unchanged SDK assets 4 + stamp, SDK pairing store 1, ART 2, test results 7); no RIFF/WAV or unexpected file |

Accuracy (two RI-2 scorers, agree on every clip): **WER 7.05% normalized
(7.43% raw)**, identical to the RI-2 packaged-SDK result; 30 s 6.02%, 60 s
8.23%, 180 s 6.84%.

Development measurements (app process, VmHWM reset per run, 200 MiB app
baseline): 30 s total 3.6-6.3 s, 60 s 10.5-10.8 s, 180 s 28.9-35.0 s (RTF
0.12-0.21); first partial 3.3-7.5 s (includes the model load on the first
request); peak RSS 376-381 / 415-431 / 464-481 MiB.

### 4.4 UI journey (`e2e/aj-ri2/transcription-journey.mjs`)

Real UI, the e2e build's capture (pushed clip as microphone input at
real-time pace), vault-backed production source, packaged SDK. Stage 7
(`fe7abfb`): J00-J05 pass; J07's functional checks passed but its last
assertion (one UI dump) missed the recording view and was replaced by a
bounded wait (`b2d8aa0`); the final run is in §4.1.

| Step | Stage 7 result |
|---|---|
| J01 30 s record → Finish → final transcript | pass; Finish to transcript 11.6 s |
| J02 60 s | pass; 14.8 s |
| J03 178 s recording, HOME (locks at once) during the pass, relaunch, unlock | pass: app locked, no transcript survived the lock, the pass was queued again and completed 55.7 s after the lock |
| J04 60 s, `kill -9` of the app during the pass | pass: the restarted process started locked; after unlock the recording was intact and the pass completed 32.2 s after the kill |
| J05 60 s, user Cancel during the pass, then Transcribe | pass: no transcript after cancel; retry completed |

### 4.5 Regressions (stage 7, `fe7abfb`)

- Existing AJ-2 voice-entry journey (`e2e/aj2/voice-journey.mjs`, node
  companion, pinned `jfk.wav`): **7/7** — capture, SDK final pass, organize
  through the public SDK, cited source line, exact cited audio range played,
  no transcript words in the device or companion log.
- Focused organize/node compatibility on the RI-2 AAR
  (`e2e/aj2/organize-e2e.mjs --only O00,O01,O03`): **3/3** — pairing with
  compared codes, consent then stored result, cancel stores nothing.
- `VaultDeviceTest` on device: pass.

## 5. Review

- Self-review of the full branch diff before the independent review.
- Independent read-only review of `837a77b..97e99a5`: **CHANGES-REQUIRED**:
  (1) closing after the `stream()` collector preceded the SDK terminal
  (`NativeExecutionOperation.close()` only defers destroy) and the docs
  overclaimed; (2) no native lock gate; (3) user-cancel races; NITs:
  concurrent source close, file key not zeroed on reader-init failure,
  overridable AAR pin, engine leftovers in e2e. Fixed in `fe7abfb`.
- Re-review of `fe7abfb`: **PASS-WITH-NOTES** (findings 1, 3-6 fixed; SDK
  side checked read-only: closing after `End` is safe, `nextEvent` keeps
  returning `END`). R1 (no lock gate before the first transcription in a
  process) and N1-N3 (watchdog timing, watchdog reported as timeout, pull
  exception release order) fixed in `002d96d`; N4 doc bounds corrected.
  Scope point S1 (queued pull primitives instead of the `stream()` wrapper)
  decided by `AJ-RI2-DEC-003` (Option A).
- `AJ-RI-2-REV-1`: ACCEPTED at `09e3580`.

## 6. Not verified, deferred, and process notes

- **Deferred / UNVERIFIED:** physical Android devices (arm64-v8a packaged,
  not executed), iOS/Swift/RN-iOS (`GRI-6-I`), thermal and battery, audio over
  180 s (refused by design), a larger journal-style speech corpus, release
  packaging (debug AAR per `AJ-RI2-DEC-002`).
- **Live text:** not implemented (`AJ-RI2-DEC-001`).
- **Process notes:** stage 3 installed over pre-RI-2 app data on the AVD
  (this exposed the legacy model cleanup). One full Jest integration run was
  started by mistake while a stage-6 emulator journey ran; stage-6 timings
  are therefore not cited. Harness defects found and fixed during the runs:
  Finish overshoot near 3:00 (J03), `kill` needing root on the emulator and
  `pidof` exiting non-zero after the kill (J04), a 30 s pass finishing before
  Cancel could be tapped (J05 moved to 60 s), and a one-shot dump in J07.
