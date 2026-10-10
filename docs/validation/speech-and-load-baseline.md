# Speech and Load Baseline (Android emulator)

**Status:** Development baselines, not production budgets. Measured on
emulators only; no physical device has been used. iOS is not covered.
**Date:** 2026-10-10.
**App revision:** `52cb23d`, release APK with R8. The test scripts were
updated afterwards; behaviour is unchanged.
**Hybrid AI SDK:** `hybrid-ai-react-native-0.1.0-m5.tgz` (SHA-256
`4761ea3b…8b74`) and `hybrid-ai-android-release.aar` (SHA-256
`ed8ee30c…3579`), both built from `e0fc3c5` (G5-A `07a8bf7`).
**Speech engine (ADR-016):** whisper.cpp v1.9.5 (`d1be6fde`, archive SHA-256
`ff1a9053…dc1720`), in the app's own native library, with greedy decoding.

## 1. What is measured and how accuracy is checked

| Path | Input | Output check |
|---|---|---|
| On-device transcription (app-owned) | Real read speech: LibriSpeech, many speakers | Word and character error rate against human reference transcripts (substitution, deletion, and insertion counts). The host re-scores every file independently, and the two scores must agree. |
| Hybrid AI SDK local capabilities | Synthetic requests | Schema checks: `test.echo` must return its input exactly, and `vector.embed` must return 2 finite numbers. Every request is audited for exactly one terminal event, in-order sequence numbers, and explicit targets that never switch. |

The SDK's packaged local models are fixtures, so their output quality is
**not** an accuracy measure:

- `text.complete` is a 260K-parameter story model with 8 output tokens;
- `vector.embed` is a 4→2 MatMul fixture.

For these, the SDK local suite measures the runtime's throughput, queueing,
cancellation, deadlines, policy handling, and stability.

## 2. Dataset

- **Source:** LibriSpeech test-clean and test-other (OpenSLR SLR12, CC BY 4.0;
  read English speech from LibriVox public-domain recordings). The archives
  are pinned by MD5 and SHA-256:
  - test-clean: MD5 `32fa31d2…49a9`, SHA-256 `39fde525…6c23`;
  - test-other: MD5 `fb5a5037…3135`, SHA-256 `d09c181b…1c29`.
- **Selection:** a deterministic 3 utterances per speaker, each with 8–40
  reference words. That gives 219 utterances from 73 speakers:
  - test-clean: 60 F and 60 M;
  - test-other: 51 F and 48 M.
- **Conditions:**
  - clean;
  - cafe babble from 3 other talkers, at 10 dB and 5 dB SNR;
  - pink noise at 20 dB;
  - quiet far-field (-24 dB);
  - 3- and 10-minute long-form recordings.

  In total, 800 WAV files (16 kHz mono 16-bit) and 109.1 minutes of audio,
  each recorded with its SHA-256. Audio is never committed.
- **Integrity:** before inference, every file used in a run is re-hashed on
  the device and compared with the manifest. A mismatch aborts the run.
- **Tools:** `e2e/speech/prepare-dataset.mjs` (dataset),
  `e2e/speech/build-reference-engine.sh` (pinned engine and models), and
  `e2e/android/aj-speech.mjs` (in-app runs).

## 3. Model choice: standalone engine on the emulator

These are the same 20 speakers (test-clean, clean), run with `whisper-cli`
in an adb shell, 4 threads, greedy decoding. The emulator is
`hybrid-ai-api35-net` (API 35 x86_64, 2 GB, 4 vCPU).

| Model | Size | WER | CER | RTF corpus | RTF p95 | Peak RSS |
|---|---:|---:|---:|---:|---:|---:|
| tiny.en | 75 MB | 8.13% | 2.93% | 0.392 | 0.669 | 146 MB |
| tiny.en-q5_1 | 31 MB | 9.17% | 3.30% | 0.270 | 0.515 | 100 MB |
| base.en | 141 MB | 6.67% | 2.15% | 0.972 | 1.648 | 236 MB |
| **base.en-q5_1** (default, ADR-016) | 57 MB | **5.83%** | **1.88%** | 0.597 | 1.008 | 149 MB |

The owner chose `base.en-q5_1` as the default and `tiny.en-q5_1` as an
explicit low-resource option, with no automatic switching.

## 4. In-app baseline (`52cb23d`)

The run uses the release APK with R8 on emulator `aj-api35-4g` (API 35
x86_64, 4 GB, 4 vCPU, software GPU). It covers the same 20 speakers,
transcribed inside Audio Journal with 4 threads and no UI animation. All 20
files were SHA-256-verified on the device, the in-app and host scores agree
on all 20, and no transcript appeared in logcat.

| Metric | base.en-q5_1 | tiny.en-q5_1 |
|---|---:|---:|
| Files ok / failed | 20 / 0 | 20 / 0 |
| WER / CER | **5.83% / 1.88%** | 9.17% / 3.30% |
| Substitutions / deletions / insertions (480 words) | 20 / 2 / 6 | 31 / 1 / 12 |
| RTF, corpus | 0.616 | 0.252 |
| RTF p50 / p95 / max | 0.611 / 1.133 / 1.393 | 0.255 / 0.421 / 0.594 |
| Inference p50 / p95 | 5,575 / 6,165 ms | 2,265 / 2,498 ms |
| Cancel acknowledged, p50 | 0.33 ms | 0.36 ms |
| Native compute released after cancel, p50 | 4,667 ms | 1,734 ms |
| Process peak RSS (VmHWM) | 354 MB | 305 MB |
| Process CPU, mean of 4 cores | 376% | 329% |
| Thermal status, max | 0 | 0 |
| WER by speaker gender | F 4.83% (13 files), M 8.05% (7) | F 8.76%, M 10.07% |

In-app accuracy is identical to the standalone engine, and in-app speed
matches it (0.616 against 0.597 RTF).

## 5. Findings from the investigation

The in-app engine first ran 3–5× slower than standalone (RTF about 1.8–2.0).
`simpleperf` showed identical kernels in both: 72–75% of the time is in
`ggml_vec_dot_q5_1_q8_1_generic`. Two causes were found:

1. **UI animation contention.** The Load lab's animated spinner kept the
   emulator's CPU compositor busy (about 0.8 core). ggml synchronizes its
   worker threads at a barrier after every operation, so one preempted
   worker stalls all of them. With static progress text, speed returned to
   the standalone figure. *Product guidance:* screens running long
   transcription should not animate, and live passes during recording
   should leave one core free. This is measured on the emulator only.
2. **Measurement interference.** Running `dumpsys meminfo` on the app every
   5 s makes the app walk its own heap and smaps mid-inference. Samples
   during runs now read only `/proc/<pid>/{status,stat}`.

Also recorded:

- **Cancellation.** whisper.cpp v1.9.5 checks its abort callback only between
  encoder and decoder passes. The app acknowledges a cancel immediately and
  the engine releases the CPU at the next boundary (about one encoder pass,
  as in the table above).
- **x86_64 builds.** These use the scalar q5_1 kernel, because ggml's AVX
  paths are off for Android cross-builds. Physical arm64 devices use NEON
  and are expected to differ; they are not yet measured.

## 6. Hybrid AI SDK local load suite

The suite ran in Audio Journal's Load lab against the packaged SDK's local
mode with the app-provisioned packaged models (`Local models: loaded`). It
used the release APK with R8 (`52cb23d`) on `aj-api35-4g`, with
`/proc`-only sampling during the run. All **15 of 15 workloads passed:
6,088 requests and 0 invariant violations** (exactly one terminal event per
request, in-order sequences, explicit targets never switched, outputs valid).
The SDK wall time was 7.2 s.

| Workload | Concurrency | Requests | Result | Throughput | Latency p50 / p95 / p99 (ms) |
|---|---:|---:|---|---:|---|
| `test.echo` sequential | 1 | 300 | 300 ok | 1,250/s | 0.51 / 2.53 / 4.27 |
| `test.echo` | 8 | 1,000 | 1,000 ok | 1,692/s | 3.75 / 11.19 / 17.16 |
| `test.echo` | 64 | 2,000 | 2,000 ok | 2,134/s | 26.85 / 39.15 / 78.31 |
| `test.stream` | 16 | 500 | 500 ok | 1,332/s | 11.43 / 21.61 / 25.28 |
| `text.complete` (llama.cpp) sequential | 1 | 40 | 40 ok | 120/s | 7.03 / 13.54 / 42.0 |
| `text.complete`, queued on the single local worker | 8 | 80 | 80 ok | 172/s | 26.86 / 134.68 / 161.48 |
| `vector.embed` (ONNX) sequential | 1 | 300 | 300 ok | 473/s | 1.13 / 7.15 / 9.37 |
| `vector.embed` | 16 | 1,000 | 1,000 ok | 628/s | 23.35 / 50.74 / 78.78 |
| `text.complete`, `auto` | 4 | 40 | 40 ok, reason `only_eligible_local` | 114/s | 25.73 / 82.37 / 99.25 |
| Cancellation storm (cancel after 2 ms) | 32 | 64 | 62 cancelled, 2 completed | 542/s | 46.97 / 61.79 / 85.06 |
| Deadline 1 ms (`text.complete`) | 16 | 64 | **64 completed**; see the defect below | 147/s | 90.56 / 264.72 / 378.47 |
| Policy denies local, explicit `local` | 8 | 200 | 200 × `POLICY_DENIED` | 802/s | 10.07 / 18.03 / 21.91 |
| Policy denies local and node, `auto` | 8 | 200 | 200 × `NO_ELIGIBLE_TARGET` | 606/s | 11.83 / 26.66 / 37.94 |
| Schema-invalid input | 8 | 200 | 200 × `SCHEMA_VALIDATION_FAILED` | 580/s | 11.32 / 31.54 / 41.2 |
| Explicit `node` with no node | 8 | 100 | 100 × `NODE_NOT_PAIRED` | 668/s | 9.61 / 27.73 / 29.03 |

**Process resources during the run:**

- RSS rose from 216 to 253 MB (peak 256 MB), with 66 threads throughout.
- CPU averaged 65% and peaked at 135% of the 4 cores.
- Thermal status stayed at 0.
- Idle PSS was 71.4 MB before the run and 118.1 MB after; native heap rose
  from 18.8 to 36.5 MB. The SDK's local models are loaded on first use, so a
  rise is expected. A leak check over a long soak is not yet done.

**Startup:**

- Cold launch to the lock screen took 542–577 ms (4 valid samples); the
  fifth sample returned no timing.
- Warm launch took 36–71 ms.
- These startup samples overlapped a stray diagnostic probe of mine, so
  treat them as indicative.

**Soak.** A 10-minute mixed local soak was started by hand on an earlier
build. Rounds #168–#172 were observed passing, 400 requests each with 0
violations, before that emulator instance crashed (a host-GPU rendering
fault). Its full results were not collected, so no soak figure is claimed.

**SDK defect report (not fixed here).** Local requests ignore their
deadline. All 64 `text.complete` requests with `timeoutMs: 1` completed
(p99 378 ms) instead of failing with `DEADLINE_EXCEEDED`. The SDK's local
executor checks cancellation but not the end-to-end deadline
(`core/src/local_executor.cpp`), while SDK-FR-19 requires deadline support
end to end.

- **Severity:** medium.
- **Affected API:** `execute`/`stream` with `execution: 'local'`, or
  `'auto'` when it resolves to local.
- **Workaround:** apps can cancel on their own timer.
- **Reproduction:** workload L11.

## 7. Not yet measured

- In-app speech on the noise conditions, test-other, and the 3/10-minute
  long-form recordings. The dataset is ready; these are about 45 minutes of
  runs.
- Run-to-run variance (each figure above is a single run), and the API 28 and
  API 26 profiles.
- Physical `arm64-v8a` devices: speed, memory, thermal behaviour, battery.

## 8. Reproduction

```sh
cd e2e/speech && npm ci && node prepare-dataset.mjs && ./build-reference-engine.sh
# standalone reference engine on the attached device
AJ_WHISPER_DIR=.cache/whisper node run-eval.mjs --engine device --model base.en-q5_1 --suite smoke
# in-app (release APK; take the exclusive-run lock first)
node ../android/aj-speech.mjs --apk ../../android/app/build/outputs/apk/release/app-release.apk \
  --model base.en-q5_1 --suite smoke --threads 4 --cancel-probes 3 --fresh
```
