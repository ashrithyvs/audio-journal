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

**How these were found:**

- Audio Journal uses only the SDK's public API.
- The SDK source was read only to locate causes; nothing in the SDK
  repository was changed.
- The pinned package is not patched or waived.

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

## SDK-AJ-3: local requests ignore their deadline (SDK-FR-19)

**Affected:** the same SDK version and artifacts as SDK-AJ-1.

**Severity:** medium. Reported earlier; the details are in the
[speech and load baseline](speech-and-load-baseline.md#6-hybrid-ai-sdk-local-load-suite).

**Observed:** all 64 `text.complete` requests with `timeoutMs: 1` completed
instead of failing with `DEADLINE_EXCEEDED`.

**Where:** `core/src/local_executor.cpp` checks cancellation but not the
end-to-end deadline.
