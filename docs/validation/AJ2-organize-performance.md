# AJ-2 Organize Performance Suite

**Status:** required for AJ-2 completion; rerun cumulatively in AJ-4.
**Scope:** AI organization only, the complete `journal.organize@1` path
through the public Hybrid AI SDK. It is not a recording, speech-to-text, or
SDK capability load benchmark:

- transcription is measured by `e2e/android/aj-speech.mjs`
  ([speech and load baseline](speech-and-load-baseline.md));
- SDK capability load is measured by the load lab (`e2e/android/aj-load.mjs`).

**Labels:** emulator and host figures are **development baselines**. The
accepted matrix is repeated on physical Android hardware later (AJ-4).

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

DEVICE-TBD

## 6. Findings and open questions

- **O-7 (proposed, not frozen):** entries longer than about 26.5 minutes of
  speech cannot be organized in one request. The options are to refuse (the
  current behaviour), or to select or chunk by time range with merged
  results. Chunking would change the contract (§2, §7) and needs an ADR. It
  blocks only long-entry organization.
- **SDK-AJ-5:** a cancel during a pending event read is not sent to the
  node, so node work continues. The app-side cancel latency is unaffected.
  See [SDK findings](hybrid-ai-sdk-issues.md#sdk-aj-5-a-cancel-during-a-pending-event-read-is-not-sent-to-the-node).
