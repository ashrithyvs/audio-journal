# Hybrid AI SDK Backlog Findings from Audio Journal

**Audience:** the Hybrid AI SDK owner.

**Status:** these are **SDK backlog findings, not accepted SDK changes**. They
are kept in the Audio Journal repository, by decision `AJ3-REV-003`
(2026-10-10), for the SDK owner to import. The frozen SDK repository was not
edited, and no external issue was filed.

**Scope:**

- Packaged SDK `0.1.0-m5`: `hybrid-ai-react-native-0.1.0-m5.tgz` (SHA-256
  `4761ea3b…8b74`) and `hybrid-ai-android-release.aar` (`ed8ee30c…3579`), both
  built from `e0fc3c5`.
- Reference node at `07a8bf7`.

SDK-AJ-1 to SDK-AJ-5 were found on those packages. From 2026-10-12 the app
pins the SDK-AJ-5 packages built from SDK `c4b302e` (ADR-015 amendment),
which the SDK owner accepted and merged into SDK `main` (`855edaf`; `main` at
`59b2cd8`). Those packages closed SDK-AJ-5 below.

**How these were found:**

- Audio Journal uses only the SDK's public API.
- The SDK source was read only to locate causes; nothing in the SDK
  repository was changed.
- The pinned package is not patched or waived.

This is now the canonical AJ-side register for `SDK-FINDING-###` handoffs.
New entries must include the AJ and SDK/package hashes, environment and model
profile, expected/observed behavior, minimal public-API reproducer, an
AJ/harness/device/network/node/model/SDK isolation record, scrubbed evidence,
RCA with confidence and source citations, proposed SDK fix and regression
tests, and the AJ suites required after a replacement package. Read-only SDK
inspection is allowed; SDK edits and acceptance are not owned here.

The AJ-side workarounds and fixes are tracked in the
[AJ-3 report](AJ3-android.md) and in the decision inbox.

## SDK-AJ-1: a revocation seen on the request path is not persisted

**Affected:**

- SDK `0.1.0-m5`, built from `e0fc3c5`.
- `hybrid-ai-react-native-0.1.0-m5.tgz`, SHA-256
  `4761ea3b7fa29b34256fcb03f201b24bd69cf05a59c300b469e82338cafd8b74`.
- `hybrid-ai-android-release.aar`, SHA-256
  `ed8ee30c95ce6c30dbea0d4bb98f7003929a5249d2c76defc2fd8cbfe1ed3579`.
- Reference node at `07a8bf7`.

**Severity:** medium. Requests fail closed, so no data is exposed. The state
APIs are inconsistent until the next connect.

**Found by:** AJ-3 device step S17, 2026-10-10. Decision: `AJ3-REV-001`.

**Evidence:**

- `audio-journal/e2e/speech/results/aj3-run5/`, S17 attempt 4, with
  `report.json` fields `revokedRequest` and `revokedLabelAfterRefusal`, and
  `evidence.json` notes "after the refused request" and "after a restart";
- the interim AJ-1 run, `audio-journal/e2e/speech/results/aj3-aj1-94604ca/`.

The results directories are git-ignored and kept locally.

**Observed:**

1. A paired, connected device; the node operator revokes its pairing
   (`DELETE /admin/pairings/<id>`). The node closes the device's sockets.
2. The next `execute`/`stream` with `execution: 'node'` fails with
   `NODE_TRUST_REVOKED`. This is correct.
3. After that:
   - `node.status()` still returns `connected`;
   - `pairedNodes()` still reports the record as `paired` and active;
   - the registry keeps the node's capabilities.
4. Only the next `node.connect()` or `refreshCapabilities()` changes the state:
   - the record becomes `revoked` and inactive;
   - the status becomes `revoked`;
   - one further `connect()` makes the status `none`.

**Root cause (read-only review of the SDK source, 2026-10-11):** a request
answered `DEVICE_NOT_PAIRED` is mapped to `NODE_TRUST_REVOKED` for the caller
(`core/src/node_protocol.cpp:523`), but the request path
(`core/src/node_executor.cpp`, `core/src/node_client.cpp`) never calls
`PairedNodeService`; only the connect and refresh paths mark the record
revoked (`handle_untrusted`, `core/src/pairing_node.cpp:155`).

**Expected:**

- LLD §4, merge rule 6: "Remove node targets when trust is revoked; keep local
  targets".
- LLD §8.5: trust-store states.
- The SDK already treats `DEVICE_NOT_PAIRED` on a pin-verified channel as an
  authenticated revocation (`node_protocol.cpp:522-523`), so the request path
  has the same proof that `handle_untrusted` acts on.

**Where:**

- `core/src/node_protocol.cpp:522-523` maps the code for the request only.
- `core/src/pairing_node.cpp:147-157` (`handle_untrusted`, which persists
  `revoked`, detaches the node, and sets the status) runs only from connect,
  refresh, and rotation (`pairing_node.cpp:215`, `235`, `385`, `430`).

**Reproduce:**

1. Pair the device with the reference node.
2. Call `DELETE /admin/pairings/<pairingId>` on the operator API.
3. Run one explicit-node request.
4. Call `node.status()` and `pairedNodes()`.

**Suggested fix:** call `handle_untrusted` (or an equivalent) when a node
request receives an authenticated `DEVICE_NOT_PAIRED`. Add a pairing scenario
that asserts `status()`, `pairedNodes()`, and the registry after a
request-path revocation. G5-A scenario 17 checks only the request and refresh
codes.

**Interim app workaround (public API):** after `NODE_TRUST_REVOKED`, call
`refreshCapabilities()` or `node.connect()`.

## SDK-AJ-2: `status()` does not reflect request-path transport failures

**Affected:** the same SDK version and artifacts as SDK-AJ-1.

**Severity:** low to medium. The state is inconsistent but the API contract
is ambiguous.

**Found by:** AJ-3 device steps S12 and S13, 2026-10-10. Decision:
`AJ3-REV-003`.

**Evidence:** `audio-journal/e2e/speech/results/aj3-run5/`, attempt 5 (the
re-run with `--rerun S12,S13`). See the `report.json` fields `networkLoss`,
`nodeDownRequest`, and `nodeDownLabel`, and the `evidence.json` notes
"network lost" and "node down".

**Observed:**

- With the network path cut, or with the node stopped, node requests fail
  with `NODE_UNAVAILABLE`; with `auto`, the reason is `node_unreachable`.
- `node.status()` keeps returning `connected` until the next `connect()`.
- `set_status` runs only on the connect, refresh, and rotation paths
  (`core/src/pairing_node.cpp`).

**Reproduce:**

1. Pair the device with the reference node and connect.
2. Stop the node process, or cut the device's path to it.
3. Run one explicit-node request. It fails with `NODE_UNAVAILABLE`.
4. Call `node.status()`. It returns `connected`.

**Expected:** either the status moves to `reconnecting` or `unavailable` once
a request has observed a transport failure, or the LLD says explicitly that
`status()` reports only the last connect result. In the second case, apps
need a documented way to re-check.

**Interim app workaround:** after `NODE_UNAVAILABLE`, call `node.connect()` and
show its outcome.

**Also observed (2026-10-11, `hybridai-81`):** the converse holds too. After a
failed connect left the status `unavailable`, and the node came back, explicit
node requests completed while `node.status()` kept returning `unavailable`
until the next `connect()`. Found by `e2e/aj1/node-f3.mjs` on the merged AJ-1
build (evidence `aj1-artifacts/evidence/f3-merge-20261011/main-a759db8/`). App
workaround (`57f316c`): a node result shows Connected at once, and one
catch-up `node.connect()` lets the SDK agree (UX §7.1).

**Root cause (read-only review of the SDK source, 2026-10-11).** Every status
write goes through `PairedNodeService::set_status` in
`core/src/pairing_node.cpp`. Its callers are revocation (`:155`), no active
record (`:182`), connecting (`:188`), authentication failure (`:202`, `:225`),
unavailable (`:210`, `:219`, `:236`), connected (`:243`), and `detach`
(`:72`), reached only from `node.connect()`, `refreshCapabilities()`,
rotation, forget, and set-active. The request path (`NodeExecutor::produce` in
`core/src/node_executor.cpp:65-136`, then `NodeClient`) never calls it, so a
request's success or transport failure never changes the status. Router
reachability likewise changes only through `set_network_available` and a
successful refresh (`core/src/hybrid_ai_c.cpp:662-664, 747-759`).

## SDK-AJ-3: local requests ignore their deadline (SDK-FR-19)

**Affected:** the same SDK version and artifacts as SDK-AJ-1.

**Severity:** medium. Reported earlier; the details are in the
[speech and load baseline](speech-and-load-baseline.md#6-hybrid-ai-sdk-local-load-suite).

**Observed:** all 64 `text.complete` requests with `timeoutMs: 1` completed
instead of failing with `DEADLINE_EXCEEDED`.

**Where:** `core/src/local_executor.cpp` checks cancellation but not the
end-to-end deadline.

## SDK-AJ-4: the node protocol leaves job-creation status and framing undocumented

**Affected:** the published node protocol (SDK ADR-021, `schemas/v1/node/`)
at the same SDK version.

**Severity:** low (documentation). Found while building the Audio Journal
node companion (AJ-2), the first node not written in the SDK repository.

**Observed:** the published documents fix the resources, envelopes, limits,
and error codes. They do not fix:

- the HTTP status of `POST /v1/jobs` for a new job and for an idempotent
  replay;
- the response framing (`Content-Length` or chunked transfer encoding);
- the WebSocket framing of event messages (fragmentation, masking, and
  frame size) beyond the 64 KiB payload limit.

A third-party node therefore has to choose, and could choose something that
the packaged SDK does not accept. The framing choices are in fact hard
requirements: the SDK's frame reader (`core/src/node_http.cpp`, read while
diagnosing SDK-AJ-5) rejects fragmented frames, masked frames, and frames
with a 64-bit length.

**Audio Journal's choice:** `201` for a new job, `200` for a replay, an
explicit `Content-Length` on every response, and unfragmented, unmasked
RFC 6455 text frames. These are proven end to end against the packaged SDK on
the emulator ([AJ-2 report](AJ2-progress.md)), not taken from SDK source.

**Suggested fix:** state these choices, or the accepted alternatives, in
ADR-021 or the node schemas.

## SDK-AJ-5: a cancel during a pending event read is not sent to the node

**Status: closed in the Audio Journal path by consumer evidence
(2026-10-12)**, on the SDK packages built from `c4b302e`, which the SDK
owner accepted and merged into SDK `main` (merge commit `855edaf`, `main`
at `59b2cd8`):

- AAR `8751a5a7623a2c6ea5a75216afd410d9483410da3c9f96f4c4527c852da86b1a`;
- RN tarball `a11cba67036d6e38662e6485c75d891dfc0110ebc41cd05aa7ea8f870c14ee2a`.

See **Closing evidence** below. The merge did not change the packages.

The SDK's documented limitation stays: a cancel that arrives before the
job-creation response, while the job ID is still unknown, cannot be
forwarded. The node then finishes or expires that job, and the app still
stores nothing. Below is the original handoff (root cause, reproduction,
and re-test), kept as written on 2026-10-11.

**Affected:** the same SDK version and artifacts as SDK-AJ-1, with any node.

**Severity:** medium. No app data is affected. Node work and retention are
wasted, and a completed result can then surface on an identical retry.
Found by the AJ-2 device suite on 2026-10-11.

**Observed:** the app cancels a `journal.organize@1` run after the node
accepted the job. This is suite step O03, with the companion slowed to four
10-second stages. Then:

- the app receives `cancelled` at once and stores nothing, as required;
- the node never receives `DELETE /v1/jobs/{jobId}`. It runs the job to
  completion: `"state":"completed","ms":50062` in
  `aj2-device/api35-run2/companion-2.log`.

**Reproduce:**

```sh
ANDROID_SERIAL=emulator-5554 node e2e/aj2/organize-e2e.mjs --apk <app.apk> --only O00,O03
```

The step records the node's final job state.

**Root cause** (from the SDK source, read only):

- `NodeClient::stream` (`core/src/node_client.cpp`) sends `cancel(job_id)`,
  which is `DELETE /v1/jobs/{jobId}`, only when it finds the token cancelled
  at the top of its loops.
- The WebSocket `receive` (`core/src/node_http.cpp:195`) is itself
  cancellation-aware: `read_exact` returns `Cancelled` while it waits for
  the next frame.
- `stream` then returns `frame.error()` from its receive-error branch
  without calling `cancel(job_id)`. A cancel almost always arrives during
  that wait, so in practice the DELETE is skipped.
- The same applies when `connect_events` itself returns `Cancelled`.

**Impact:**

- The node keeps computing until completion or the deadline (up to 120 s).
- Its job stays retained until then.
- Repeated cancels pile up node work.
- The job lifecycle in the SDK's LLD §10 (RUNNING → CANCELLED) and
  `NodeClient::cancel` are therefore not exercised for the common case.

**Audio Journal:** no workaround is possible through the public API, and
none is needed for correctness. The app stores nothing on `cancelled` and
never retries. The device suite records the node-side state instead of
asserting it.

**Suggested fix:** in `stream`, call `cancel(job_id, …)`, bounded by its own
short attempt as the loop-top path already is, before returning `Cancelled`
from the receive and connect paths.

**Re-test to close it.** Run this once a fixed packaged SDK is pinned in
Audio Journal:

1. Run the device suite strictly:
   `ANDROID_SERIAL=… node e2e/aj2/organize-e2e.mjs --apk <app.apk> --only O00,O03 --expect-node-cancel`.
   It requires:
   - the app shows Cancelled and stores nothing;
   - the companion's job ends `cancelled` within 15 s of the cancel, which
     proves the node received the cancellation and stopped processing;
   - an identical retry is computed afresh (`engineMs` present) and stored,
     so no completed result from the cancelled job surfaces.
2. Rerun the organize performance suite's cancel block. Its five node jobs
   must log `job-ended` with `state: "cancelled"`.
3. Node-side readiness is already proven on the host. The companion test
   "a cancelled job keeps no result" (`node-companion/test/protocol.test.mjs`)
   shows that after a DELETE the job is `cancelled`, has no `output`, keeps
   no replay record, and an identical retry is recomputed.

The re-test is prepared but **cannot pass** until a fixed packaged SDK is
installed. The companion evidence in step 3 is direct `DELETE` calls to the
companion. It proves the companion's cancellation behaviour only and does
not close this SDK defect.

**Still reproduced, 2026-10-12** (AJ-2.2 build `d865385`, the same packaged
SDK): O03 in `aj2-device/functional-aj22-api35/`. The app showed Cancelled
and stored nothing; the node's job ended `completed`, 45.8 s after the
cancel.

### SDK-AJ-5 closing evidence (2026-10-12)

**Setup:**

- App `aj2/organize` at `2903a7c`.
- Release APK `22c0f35d422399cd9eb6595dd9b4274031ce9928263b718cf5b08a0f8506e015`.
  It embeds the accepted package's `libhybrid_ai_core.so` for both ABIs: `x86_64`
  `dbc94964…`, `arm64-v8a` `783e25e4…`. Each is byte-identical to the
  `c4b302e` AAR and differs from `e0fc3c5`.
- Emulator `aj-api35-4g`.
- Evidence in `aj1-artifacts/evidence/aj2-sdkaj5/`.

The companion now logs each device DELETE as a count-only
`job-cancel-request`. The developer benchmark records the gateway's
terminal-event count per run.

| Check | Run | Result |
|---|---|---|
| Closing test `organize-e2e.mjs --only O00,O03 --expect-node-cancel` | `closing-o03/` | Pass. The app showed Cancelled once, and nothing was shown or stored. The companion received exactly 1 cancellation. The node job ended `cancelled` within 11.8 s of the tap (the harness bound includes UI waits); the companion logged the DELETE and the `cancelled` end 1 ms apart. `replays` was unchanged: no result retained. The identical retry was recomputed (`engineMs` 9, `completed`) and stored as `stored`, not `existing`, so the cancelled run had stored nothing |
| Performance cancel block `organize-perf.mjs --only cancel --expect-node-cancel` | `closing-perf-cancel/` | 5/5 `cancelled` in the app with exactly 1 terminal event each. 5 DELETEs, 5 node jobs `cancelled`, 0 retained |
| The same block inside the full matrix | `perf/` | The same: 5/5 at both ends. Cancel → terminal 106 / 112 ms p50/p95, against 94 / 98 ms before the fix (the DELETE round trip) |
| Full functional suite `--expect-node-cancel` | `functional-run2/` | 9/9. O03 held to the same strict checks (1 cancellation, `cancelled`, 0 retained, the retry recomputed and stored) |
| Fresh AJ-3 S00–S19 on the same APK | `aj3/` | 20/20 (no regression) |

The same `e0fc3c5` steps (O03, and the cancel block in performance runs
1–3) had recorded 0 of 5 cancelled at the node.
