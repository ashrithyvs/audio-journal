# AJ-2 Organize Performance Suite

**Status:** required for AJ-2 completion; rerun cumulatively in AJ-4.
**Scope:** AI organization only, the complete `journal.organize@1` path
through the public Hybrid AI SDK. It is not a recording, speech-to-text, or
SDK capability load benchmark:

- transcription is measured by `e2e/android/aj-speech.mjs`
  ([speech and load baseline](speech-and-load-baseline.md));
- SDK capability load is measured by the load lab (`e2e/android/aj-load.mjs`).

**Labels:**

- **Deterministic `aj.rules` organization baseline.** Every figure here was
  measured with the companion's deterministic, rule-based engine. The
  figures measure the complete SDK integration path:
  - the app's build and validation;
  - the SDK's routing, TLS, HTTP, and WebSocket protocol;
  - the companion's job handling;
  - rehearsed persistence;
  - rendering.

  They are kept as the **protocol and SDK overhead baseline**. They are
  **not** representative of model-backed AI inference or of organization
  quality. A model-backed engine needs a separate baseline of its own,
  measured with this same suite.
- **Development baselines.** Emulator and host figures are not product
  numbers. The accepted matrix is repeated on physical Android hardware
  later (AJ-4).

## 1. Path under test

Each run covers the full path:

1. The app's own request builder (`buildOrganizeRequest`).
2. The app's `HybridAiGateway`, i.e. the packaged SDK's public `stream()`,
   with `execution: 'node'` and `timeoutMs: 60000`.
3. The node companion's TLS endpoint and `aj.rules` engine.
4. The terminal event.
5. The app's §6 validator (`resultViolation`).
6. Persistence.
7. The result on screen.

The runner is the developer **Organize benchmark** (Settings → Developer
diagnostics), `src/features/organize/bench/`. The harness is
`e2e/aj2/organize-perf.mjs`.

**Persistence is rehearsed.** Benchmark transcripts are synthetic and are
never stored. `SqliteDerivationRepository.rehearseSave` runs the same
writes and read-back as a real save, then rolls back, with foreign keys
deferred. The commit itself is not in the persistence time. Committed saves
are covered end to end by the functional device suite (`organize-e2e.mjs`,
O01, O04, O07).

## 2. Fixtures

The fixtures are deterministic, finalized voice-journal transcripts
(`src/features/organize/bench/fixtures.ts`):

- conversational diary speech at 140 words per minute;
- engine segments of 4–9 s, as whisper produces;
- one recording each;
- all six output kinds requested.

Duration is a label only. The SDK's input dimension is the request's
serialized UTF-8 size, which the suite records for every fixture. The values
are pinned by `unit-tests/organizeBench.test.ts`:

| Fixture | Speech | Words | Segments | Request bytes | Expected |
|---|---|---|---|---|---|
| `v30s` | 30 s | 70 | 4 | 1,413 | organized |
| `v1m` | 1 min | 139 | 9 | 2,588 | organized |
| `v3m` | 3 min | 422 | 28 | 7,199 | organized |
| `v5m` | 5 min | 696 | 48 | 12,000 | organized |
| `v10m` | 10 min | 1,401 | 92 | 22,970 | organized |
| `cap` | about 26.5 min | about 3,890 | 242 | **61,108** (exact input cap) | organized |
| `over` | about 26.5 min | about 3,890 | 242 | **61,109** (cap + 1) | `TOO_LARGE` in the app's builder; nothing sent |
| `sdk-over` | the `over` input sent straight to the SDK | | | 61,109 | `SCHEMA_VALIDATION_FAILED` from the SDK; nothing reaches the node |
| `v30m` | 30 min | 4,198 | 283 | over the cap | `TOO_LARGE`; nothing sent |
| `v60m` | 60 min | 8,410 | 558 | over the cap | `TOO_MANY_UNITS` (more than 400 units); nothing sent |

Request bytes depend on the device's locale and time zone (§2 context
fields). The table uses `en-US` and `Asia/Kolkata`; each run records its own
sizes.

**30 and 60 minutes.** The frozen contract (ADR-019) has no chunking
strategy. A selection is whole entries, and an oversized one is refused,
never truncated. So these fixtures verify the expected typed refusal. At
140 wpm, about 26.5 minutes of speech fits one request. Whether to add a
selection or chunking strategy for longer entries is an open product
question for the Organized UI stage (O-7, proposed in §6).

## 3. Measurements

Every run of a measured fixture records the following:

| Metric | Definition |
|---|---|
| `buildMs` | Building and checking the request in the app (§6.1) |
| `acceptedMs` | From SDK invocation to the `accepted` event |
| `firstProgressMs` | From invocation to the first `progress` event |
| `firstPartialMs` | From invocation to the first `partial` event |
| `terminalMs` | From invocation to the terminal event (total completion) |
| `validateMs` | The app's §6 result validation |
| `persistMs` | The rehearsed persistence (§1) |
| `visibleMs` | From invocation to the first frame with the result on screen (end-to-end user-visible) |
| `nodeJobMs` | Companion: from job acceptance to its terminal event (its log) |
| `nodeEngineMs` | Companion: time inside the `aj.rules` engine |
| `inputBytes`, `outputBytes` | Canonical UTF-8 request input and result |
| App CPU, peak RSS | App process: `/proc/<pid>/stat` CPU time and `VmRSS` sampled every second, and `VmHWM` |
| Companion CPU, RSS | `process.cpuUsage`, `rss`, and `maxRSS` from the companion's admin statistics |
| Network bytes | TLS-record bytes on the companion's sockets in each direction, handshakes included; all of the device's node traffic crosses them |
| `cancelLatencyMs` | From the SDK `cancel()` call to the `cancelled` terminal (app side) |
| `deadlineOverrunMs` | The terminal time minus the 60 s deadline |
| Success rate | Outcome counts per block |

**Cold and warm.** A cold run follows a force-stop of the app and a restart
of the companion, giving a new JS runtime, SDK instance, connection, and
companion process. Each fixture then runs `--warm` times (20 by default) on
the warm connection. Reported statistics are n, min, p50, p95 (nearest
rank), max, mean, standard deviation, and coefficient of variation.

Each run of a block changes a fixed-width run token (`Run 0000.`) in the
first segment. Every request is therefore new to the node's request-key
replay (§9) and to the app, at an unchanged size.

## 4. Running

```sh
ANDROID_SERIAL=emulator-5554 node e2e/aj2/organize-perf.mjs \
  --apk <app-release.apk> --out <dir> [--warm 20] [--only v30s,cap,...]
```

The harness writes `blocks.json` (every sample), `report.json` (summary
statistics), and each companion instance's log (counts only).

## 5. Results

**Run:** `perf-api35-run1`, 2026-10-11. APK `491dfd9`, release build
(`app-release-aj2-491dfd9.apk`, SHA-256 `8a22bb05…6258`). Emulator
`aj-api35-4g`: Android SDK built for x86_64, API 35, 4 GB. Host: Intel Core
Ultra 7 155U, 14 CPUs. Companion `491dfd9` on the same host over
`adb reverse`. 20 warm runs per fixture.

Evidence is in `aj1-artifacts/evidence/aj2-device/perf-api35-run1/`
(`blocks.json`, `report.json`, `companion-*.log`), outside the repository.

**These are development baselines, not product numbers.** The emulator,
the loopback link, and a shared host make them optimistic for a phone and
LAN. AJ-4 repeats the matrix on physical hardware.

### 5.1 Organized fixtures

All 126 runs completed. Each result passed the app's §6 validation, and
its persistence was rehearsed in a transaction that was rolled back. None
was committed: these are not 126 stored derivations. The committed storage
evidence is the functional suite (O01, O04, O07, and the voice journey).
Times are in
milliseconds: p50 / p95 for 20 warm runs, a single value for the cold run.
"Completion" is SDK invocation to the terminal event; "On screen" is
invocation to the first frame showing the result.

| Fixture | Words | Request bytes | Result bytes | Accepted | 1st progress | 1st partial | Completion | Validate | Persist (rehearsed) | On screen | Node job | Node engine | Completion CV |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 30 s cold | 70 | 1,413 | 3,233 | 20 | 50 | 50 | 51 | 1.0 | 6.0 | 73 | 17 | 12 | – |
| 30 s warm | 70 | 1,413 | 3,233 | 23 / 31 | 40 / 51 | 40 / 51 | 41 / 49 | 1.0 / 2.0 | 5.7 / 9.4 | 64 / 66 | 2 / 3 | 1 / 2 | 0.22 |
| 1 min cold | 139 | 2,588 | 5,487 | 26 | 48 | 48 | 49 | 1.6 | 5.7 | 72 | 16 | 11 | – |
| 1 min warm | 139 | 2,588 | 5,487 | 20 / 31 | 38 / 55 | 38 / 55 | 38 / 48 | 1.7 / 2.6 | 8.9 / 14.4 | 64 / 80 | 3 / 5 | 2 / 2 | 0.17 |
| 3 min cold | 422 | 7,199 | 18,668 | 25 | 51 | 52 | 56 | 3.0 | 19.9 | 92 | 20 | 14 | – |
| 3 min warm | 422 | 7,199 | 18,668 | 23 / 35 | 38 / 55 | 38 / 55 | 41 / 52 | 3.6 / 8.2 | 18.1 / 31.4 | 76 / 94 | 6 / 8 | 3 / 5 | 0.17 |
| 5 min cold | 696 | 12,000 | 31,801 | 26 | 65 | 65 | 72 | 6.2 | 32.1 | 127 | 32 | 22 | – |
| 5 min warm | 696 | 12,000 | 31,801 | 18 / 30 | 39 / 50 | 39 / 50 | 43 / 55 | 6.7 / 10.5 | 26.5 / 33.6 | 88 / 106 | 8 / 10 | 5 / 7 | 0.15 |
| 10 min cold | 1,401 | 22,970 | 61,121 | 23 | 61 | 61 | 69 | 11.7 | 61.4 | 164 | 28 | 21 | – |
| 10 min warm | 1,401 | 22,970 | 61,121 | 20 / 27 | 43 / 81 | 43 / 81 | 52 / 61 | 12.3 / 14.6 | 49.2 / 67.0 | 128 / 154 | 15 / 20 | 11 / 14 | 0.18 |
| Cap cold | 3,888 | **61,108** | 61,154 | 35 | 160 | 160 | 166 | 18.5 | 59.5 | 266 | 118 | 103 | – |
| Cap warm | 3,888 | **61,108** | 61,154 | 27 / 40 | 134 / 160 | 134 / 160 | 143 / 154 | 14.7 / 17.9 | 54.4 / 63.3 | 230 / 240 | 101 / 106 | 94 / 105 | 0.14 |

**What the figures show:**

- Total time grows with the request's size, not the speech duration as
  such. From 30 s to 10 min (1.4 KB to 23 KB of request), warm completion
  stays at 38–52 ms p50. The time on screen grows from 64 to 128 ms,
  mostly through persistence and rendering.
- At the exact 61,108-byte cap (about 26.5 minutes of speech), completion
  is 143 ms p50. The companion's engine is 94 ms of it.
- From about 10 minutes of speech, results reach the 61,387-byte output
  budget. The `aj.rules` engine then drops items from its longest list
  until the result fits; lists also hold at most 50 items (§3). That is why
  the result bytes stop growing (61,121 and 61,154). Long entries therefore
  get a bounded result, with some lower-ranked items omitted. This is
  recorded as a finding (§6).
- Cold runs, after an app and companion restart, add 10–25 ms to completion
  and 9–36 ms on screen.
- Run-to-run variance is low: the completion coefficient of variation is
  0.14–0.22.

### 5.2 Resources and network

The app columns are the whole app process during the block. The companion
columns are the companion process. Wire bytes are TLS records on the
companion's sockets per run, in each direction, handshakes included.

| Block | App CPU (block) | App peak RSS | Companion CPU (block) | Companion RSS | Wire bytes in / run | Wire bytes out / run |
|---|---|---|---|---|---|---|
| 30 s warm (20 runs) | 1,080 ms | 210 MB | 264 ms | 89 MB | 3,368 | 6,299 |
| 1 min warm | 1,240 ms | 215 MB | 306 ms | 90 MB | 4,543 | 8,553 |
| 3 min warm | 1,800 ms | 211 MB | 354 ms | 96 MB | 9,154 | 21,758 |
| 5 min warm | 2,320 ms | 213 MB | 433 ms | 99 MB | 13,956 | 34,891 |
| 10 min warm | 3,380 ms | 214 MB | 689 ms | 105 MB | 24,948 | 64,255 |
| Cap warm | 5,940 ms | 233 MB | 2,595 ms | 136 MB | 63,130 | 64,290 |
| Cap cold (1 run) | 1,770 ms | 216 MB | 191 ms | 96 MB | 63,129 | 64,314 |

The app's RSS includes its on-device speech runtime (ADR-016), so the
organize path adds at most about 20 MB at the cap. Per warm run, app CPU
is about 54 ms at 30 s and 297 ms at the cap.

### 5.3 Boundaries, refusals, cancellation, and deadline

| Block | Runs | Outcome | Time | Request bytes | Sent to the node |
|---|---|---|---|---|---|
| Cap + 1 (app builder) | 5 | `TOO_LARGE` ×5 | build 13.7 ms p50 | 61,109 | nothing (0 bytes, 0 jobs) |
| 30 min (app builder) | 5 | `TOO_LARGE` ×5 | build 15.3 ms | 69,686 | nothing |
| 60 min (app builder) | 5 | `TOO_MANY_UNITS` ×5 | build 17.8 ms | 138,212 (558 units) | nothing |
| Cap + 1 sent straight to the SDK | 5 | `SCHEMA_VALIDATION_FAILED` ×5 (the SDK's "Input exceeds capability byte limit") | 3 / 4 ms to the terminal | 61,109 | nothing |
| Cancel 300 ms after the first progress (node slowed to 2 s stages) | 5 | `cancelled` ×5 | cancel → terminal 96 / 101 ms | 12,000 | the job; it was **not** cancelled at the node (SDK-AJ-5) |
| Deadline (node slowed to 25 s stages) | 3 | `DEADLINE_EXCEEDED` ×3 | the terminal 2.8 / 3.3 ms after the 60 s deadline | 2,588 | the job; the node ended it at 60,000–60,003 ms |

**Success and failure rates:**

- Measured fixtures: 126/126 completed, validated, and rehearsed (rolled
  back, not committed).
- Refusals and rejections: 20/20 typed as expected.
- Cancels: 5/5 cancelled.
- Deadlines: 3/3 `DEADLINE_EXCEEDED`.
- There were no unexpected outcomes.

**Cancellation at the node.** The 5 cancelled jobs logged no `cancelled`
end at the companion. A DELETE is acted on immediately, so none reached it:
SDK-AJ-5, reproduced. The app-side latency is unaffected.

## 6. Findings and open questions

- **The result budget binds before the request budget.** From about 10
  minutes of speech, the engine's full result for these fixtures exceeds
  61,387 bytes, so items are dropped to fit. No source is changed, and the
  dropped items are not shown. Whether to show that a result is partial,
  or to organize long entries in parts, is part of O-7.

- **O-7 (proposed, not frozen):** entries longer than about 26.5 minutes of
  speech cannot be organized in one request. The options are to refuse (the
  current behaviour), or to select or chunk by time range with merged
  results. Chunking would change the contract (§2, §7) and needs an ADR. It
  blocks only long-entry organization.
- **SDK-AJ-5:** a cancel during a pending event read is not sent to the
  node, so node work continues. The app-side cancel latency is unaffected.
  See [SDK findings](hybrid-ai-sdk-issues.md#sdk-aj-5-a-cancel-during-a-pending-event-read-is-not-sent-to-the-node).
