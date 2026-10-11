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
140 wpm, about 26.5 minutes of speech fits one request. Chunk-and-merge for
longer entries is not approved for v1 (O-7). A request that fits but whose
full result exceeds the output budget is explicitly partial (amendment A1,
§5.1).

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

These are the deterministic `aj.rules` baseline: protocol and SDK overhead,
not model inference or quality. They are development baselines from an
emulator.

**Current run:** `perf-api35-run2`, 2026-10-11, on the amended contract (A1).

- APK: `ad430fc` release build (`app-release-aj2-ad430fc.apk`, SHA-256
  `f3e9fa0e…3472`).
- Emulator: `aj-api35-4g`, Android SDK built for x86_64, API 35, 4 GB.
- Host: Intel Core Ultra 7 155U, 14 CPUs. The companion runs on the same
  host over `adb reverse`.
- 20 warm runs per fixture.

Evidence is in `aj1-artifacts/evidence/aj2-device/perf-api35-run2/`
(`blocks.json`, `report.json`, `companion-*.log`), outside the repository.
The first run, `perf-api35-run1` on `491dfd9` before A1, gave the same
timings to within run-to-run variance. It is kept as history.

### 5.1 Organized fixtures

All 126 runs completed. Each result passed the app's §6 validation, and
its persistence was rehearsed in a transaction that was rolled back.
**None was committed**: these are not stored derivations. The committed
storage evidence is the functional suite and the voice journey (AJ-2
progress §5).

Times are in milliseconds: p50 / p95 for 20 warm runs, a single value for
the cold run. "Completion" is SDK invocation to the terminal event; "On
screen" is invocation to the first frame showing the result.
"Completeness" is the result's §3.2 marker.

| Fixture | Words | Request bytes | Result bytes | Completeness | Accepted | 1st progress | 1st partial | Completion | Validate | Persist (rehearsed) | On screen | Node job | Node engine | Completion CV |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 30 s cold | 70 | 1,413 | 3,259 | complete | 16 | 41 | 41 | 43 | 0.6 | 6.2 | 70 | 11 | 9 | – |
| 30 s warm | 70 | 1,413 | 3,259 | complete ×20 | 19 / 31 | 41 / 55 | 41 / 55 | 42 / 49 | 1.0 / 1.6 | 6.6 / 8.6 | 65 / 66 | 2 / 4 | 1 / 5 | 0.14 |
| 1 min cold | 139 | 2,588 | 5,513 | complete | 21 | 47 | 47 | 50 | 1.6 | 7.3 | 73 | 22 | 17 | – |
| 1 min warm | 139 | 2,588 | 5,513 | complete ×20 | 21 / 29 | 40 / 45 | 40 / 45 | 40 / 46 | 1.5 / 1.7 | 7.1 / 11.4 | 64 / 81 | 3 / 7 | 1 / 5 | 0.09 |
| 3 min cold | 422 | 7,199 | 18,694 | complete | 18 | 56 | 56 | 59 | 3.8 | 24.7 | 98 | 27 | 20 | – |
| 3 min warm | 422 | 7,199 | 18,694 | complete ×20 | 23 / 38 | 39 / 63 | 39 / 63 | 41 / 50 | 3.8 / 5.4 | 16.5 / 25.1 | 77 / 95 | 5 / 8 | 3 / 5 | 0.16 |
| 5 min cold | 696 | 12,000 | 31,827 | complete | 21 | 62 | 63 | 69 | 5.5 | 24.5 | 112 | 33 | 22 | – |
| 5 min warm | 696 | 12,000 | 31,827 | complete ×20 | 30 / 35 | 44 / 52 | 44 / 52 | 47 / 55 | 6.5 / 9.4 | 28.0 / 32.9 | 90 / 108 | 7 / 9 | 4 / 6 | 0.12 |
| 10 min cold | 1,401 | 22,970 | 61,171 | **partial, 3 omitted** | 23 | 64 | 64 | 73 | 12.3 | 51.2 | 161 | 34 | 25 | – |
| 10 min warm | 1,401 | 22,970 | 61,171 | **partial ×20, 3 omitted** | 21 / 27 | 44 / 62 | 44 / 62 | 52 / 63 | 12.1 / 16.3 | 47.0 / 55.5 | 131 / 148 | 15 / 19 | 11 / 14 | 0.10 |
| Cap cold | 3,888 | **61,108** | 61,227 | **partial, 155 omitted** | 44 | 187 | 188 | 195 | 13.4 | 65.9 | 295 | 137 | 117 | – |
| Cap warm | 3,888 | **61,108** | 61,227 | **partial ×20, 155 omitted** | 27 / 41 | 132 / 163 | 132 / 163 | 137 / 144 | 14.0 / 18.5 | 52.4 / 64.8 | 222 / 247 | 96 / 103 | 90 / 98 | 0.14 |

**What the figures show:**

- Total time grows with the request's size, not the speech duration as
  such. From 30 s to 10 min (1.4 KB to 23 KB of request), warm completion
  stays at 40–52 ms p50. The time on screen grows from 65 to 131 ms,
  mostly through persistence and rendering.
- At the exact 61,108-byte cap (about 26.5 minutes of speech), completion
  is 137 ms p50; the companion's engine is 90 ms of it.
- **Partial results (amendment A1).** From 10 minutes of speech, the
  engine's full result no longer fits the 61,387-byte output budget, and
  these fixtures produce explicitly partial results:
  - 10 minutes: 3 items omitted;
  - the cap: 155 items omitted.

  Every one carried `completeness: "partial"` and its `omitted` counts.
  Before A1 the same items were dropped silently. The marker adds at most
  about 40 bytes.
- Cold runs, after an app and companion restart, add 2–58 ms to completion.
- Run-to-run variance is low: the completion coefficient of variation is
  0.09–0.16.

### 5.2 Resources and network

The app columns are the whole app process during the block. The companion
columns are the companion process. Wire bytes are TLS records on the
companion's sockets per run, in each direction, handshakes included.

| Block | App CPU (block) | App peak RSS | Companion CPU (block) | Companion RSS | Wire bytes in / run | Wire bytes out / run |
|---|---|---|---|---|---|---|
| 30 s warm (20 runs) | 1,150 ms | 210 MB | 283 ms | 93 MB | 3,370 | 6,321 |
| 1 min warm | 1,210 ms | 211 MB | 295 ms | 96 MB | 4,545 | 8,575 |
| 3 min warm | 1,780 ms | 216 MB | 345 ms | 98 MB | 9,156 | 21,780 |
| 5 min warm | 2,340 ms | 215 MB | 418 ms | 95 MB | 13,958 | 34,913 |
| 10 min warm | 3,390 ms | 214 MB | 670 ms | 110 MB | 24,951 | 64,301 |
| Cap warm | 5,880 ms | 233 MB | 2,541 ms | 136 MB | 63,133 | 64,359 |
| Cap cold (1 run) | 1,870 ms | 209 MB | 209 ms | 98 MB | 63,131 | 64,383 |

The app's RSS includes its on-device speech runtime (ADR-016), so the
organize path adds at most about 25 MB at the cap. Per warm run, app CPU is
about 58 ms at 30 s and 294 ms at the cap.

### 5.3 Boundaries, refusals, cancellation, and deadline

| Block | Runs | Outcome | Time | Request bytes | Sent to the node |
|---|---|---|---|---|---|
| Cap + 1 (app builder) | 5 | `TOO_LARGE` ×5 | build 13.3 ms p50 | 61,109 | nothing (0 bytes, 0 jobs) |
| 30 min (app builder) | 5 | `TOO_LARGE` ×5 | build 15.5 ms | 69,686 | nothing |
| 60 min (app builder) | 5 | `TOO_MANY_UNITS` ×5 | build 18.3 ms | 138,212 (558 units) | nothing |
| Cap + 1 sent straight to the SDK | 5 | `SCHEMA_VALIDATION_FAILED` ×5 (the SDK's "Input exceeds capability byte limit") | 2.7 / 3.9 ms to the terminal | 61,109 | nothing |
| Cancel 300 ms after the first progress (node slowed to 2 s stages) | 5 | `cancelled` ×5 | cancel → terminal 93 / 96 ms | 12,000 | the job; it was **not** cancelled at the node (SDK-AJ-5) |
| Deadline (node slowed to 25 s stages) | 3 | `DEADLINE_EXCEEDED` ×3 | the terminal 2.6 ms after the 60 s deadline | 2,588 | the job; the node ended it at 60 s |

**Success and failure rates:**

- Measured fixtures: 126/126 completed, validated, and rehearsed; 46 of
  them were partial, as marked.
- Refusals and rejections: 20/20 typed as expected.
- Cancels: 5/5 cancelled app-side.
- Deadlines: 3/3 `DEADLINE_EXCEEDED`.
- There were no unexpected outcomes.

**Cancellation at the node.** None of the 5 cancelled jobs logged a
`cancelled` end at the companion, so no DELETE reached it: SDK-AJ-5,
reproduced again. SDK-AJ-5 blocks final AJ-2 cancellation acceptance; the
re-test is in the SDK findings. The app-side latency is unaffected.

## 6. Findings and open questions

- **The result budget binds before the request budget.** From about 10
  minutes of speech, the engine's full result for these fixtures exceeds
  61,387 bytes. **Resolved by amendment A1:** such results are explicitly
  partial, with per-kind `omitted` counts of the lowest-ranked items, and
  the app discloses it. Organizing long entries in several requests
  (chunk-and-merge) is still not approved for v1 (O-7).

- **O-7, remaining part (not frozen):** entries longer than about 26.5
  minutes of speech cannot be organized in one request and are refused with
  a typed reason. Chunk-and-merge would change the contract (§2, §7), needs
  an ADR, and is not approved for v1. It blocks only organizing entries
  above the input cap.
- **SDK-AJ-5:** a cancel during a pending event read is not sent to the
  node, so node work continues. The app-side cancel latency is unaffected.
  See [SDK findings](hybrid-ai-sdk-issues.md#sdk-aj-5-a-cancel-during-a-pending-event-read-is-not-sent-to-the-node).
