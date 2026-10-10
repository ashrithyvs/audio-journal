# AJ-3 Android Validation: Secure Private AI Node Workflow

**Status: the AJ-3 node workflow passes on Android on the final AJ-1 build
`6f2b36b`, which is the merge-gate regression. The AJ-3 milestone is not
accepted yet.**

| Build | What it is | Fresh S00–S19 | Notes |
|---|---|---|---|
| `6f2b36b` | Final AJ-1 APK: the fix plus recorder, playback, transcription, AJB1 backup/restore, and a scrolling Settings screen | **20 / 20 pass** | Merge-gate run, 2026-10-10 23:18–23:58 (§8.3) |
| `72ee323` | AJ-1 (`94604ca`, `dc300cd`) plus the status fixes `0ced9a6` and `72ee323`; branch `aj1/domain-core` | **20 / 20 pass** | One non-resumed run; full-run log scan; persistent PIN (§8) |
| `94604ca` | AJ-1 checkpoint 2, before the fix | 17 / 20 | S12, S13, S17 failed (F1, F2); no AJ-1 regression |
| `52cb23d` | `main` today | 17 / 20 (composite run, §3) | The same three failures |

- **The defect the fix resolves:** the node status shown to the user did not
  reflect a failure the app had already seen.
  - After a network cut or a stopped node, requests failed with
    `NODE_UNAVAILABLE`, but the status stayed "Connected" (F2).
  - After the node revoked the device, requests failed with
    `NODE_TRUST_REVOKED`, but the status stayed "Connected". After a restart
    it said "No node paired", and "Forget and pair again" was never offered
    (F1).
  - With `72ee323` the status shows "Unavailable" or "Trust revoked", with
    the right recovery action, and returns to "Connected" after recovery.
- **What held on every build:**
  - nothing was sent to an impostor node;
  - expired, replayed, and declined pairing codes were refused;
  - revoked pairings and unreachable nodes failed closed;
  - an explicit target never switched;
  - no PIN, pairing secret, or typed input appeared in the device log.
- **Not accepted yet, because:**
  - the fix is on `aj1/domain-core` and is not on `main`. The merge-gate
    regression has passed (§8.3), but the merge itself is not part of this
    work;
  - the roadmap exit ("pair, organize, reconnect, forget the node, and
    continue using the local journal without developer tools or content
    loss", roadmap §5) and the "minimum transcript content" check also need
    AJ-1 and AJ-2, which are not complete;
  - iOS is deferred: not passed, and not "not applicable";
  - no physical device has been used.

Decisions recorded in `/home/igdclt0603/Desktop/Ash/AJ_AGENT_DECISIONS.md`,
2026-10-10:

- **`AJ3-REV-001` (F1) and `AJ3-REV-003` (F2), CHANGES_REQUIRED.**
  - Classification accepted.
  - App fix by `hybridai-81` through public SDK APIs (`0ced9a6`, `72ee323`;
    review `AJ1-REV-001`).
  - Assertions kept strict.
  - The required fresh re-run is done (§8).
- **`AJ3-REV-002` and `AJ3-REV-004`, ACCEPTED.** All test-suite changes
  accepted as non-weakening (`ccef770`).
- **`AJ3-DEC-001`, DECIDED.** SDK findings stay in this repository as
  [backlog findings](hybrid-ai-sdk-issues.md); the frozen SDK is not edited.

**Date:** 2026-10-10.

| Item | Version / source | SHA-256 |
|---|---|---|
| App APK `72ee323` (R8 release) | built by `hybridai-81` from a clean detached checkout of `72ee323` | `0c1f07276d0073bb3659c6c5948912dd4fae0237b65ac376bee2032bea0d1ba8` |
| App APK `94604ca` (R8 release) | AJ-1 checkpoint 2, built by `hybridai-81` | `98d3ee40a87a6f928b703acc17c043523fe786247d6dabb85b54760482b3d1ab` |
| App APK `52cb23d` (R8 release) | product tree of `52cb23d`. Built 2026-10-09 23:43 IST; no file under `src/` or `android/` has changed since. | `4ffeecf97d44fe4776870b10cfbdbdfab2ea582329d13fa0cbe5a9516ac8da68` |
| `hybrid-ai-react-native-0.1.0-m5.tgz` | built from `e0fc3c5` (G5-A `07a8bf7`) | `4761ea3b7fa29b34256fcb03f201b24bd69cf05a59c300b469e82338cafd8b74` |
| `hybrid-ai-android-release.aar` | built from `e0fc3c5` | `ed8ee30c95ce6c30dbea0d4bb98f7003929a5249d2c76defc2fd8cbfe1ed3579` |
| Reference node | SDK repository `reference-node/src/paired.mjs` at `07a8bf7`; an external process reached through `adb reverse`; only its loopback operator API is used | — |
| Device suite | `e2e/android/aj3-e2e.mjs`, `e2e/android/lib/device.mjs`. The `72ee323` runs used `ccef770`; the earlier runs used its uncommitted predecessors | — |

The tarball's SHA-512 matches `package-lock.json`, and the AAR's SHA-256 is
checked at every build (`android/hybrid-ai-android`).

**Environment:**

- `emulator-5554`: AVD `aj-api35-4g`, used for run 3.
- `emulator-5556`: AVD `aj-api35-4g-b`, used for run 5 and for both AJ-1
  builds; headless from 14:14.
- Both: API 35 x86_64, 4 GB, 4 vCPU, software GPU (`swiftshader_indirect`).
  The build fingerprint is
  `Android/sdk_phone64_x86_64/emu64x:15/AE3A.240806.019/12368160:userdebug/test-keys`.
- Host: Linux x86_64, Node.js 22.22.1.
- No physical device has been used.

## 1. How it was tested

The device suite drives the real release app with `adb` and `uiautomator`.
Selectors are React Native `testID`s.

- **Evidence is UI-hierarchy text.** `FLAG_SECURE` blocks screenshots by
  design.
- **The operator role is real.** The suite issues codes, reads the node's
  pending verification code, approves, revokes, drops connections, and stops
  or replaces the node through the reference node's operator API.
- **Discovery uses a test-only fixture APK.** It advertises through Android's
  public `NsdManager` and contains no SDK code.
- **Resumable.** A run can resume after a failure: passed steps are skipped,
  and each attempt's results, report fields, and UI evidence are kept
  (`checkpoint.json`, `report.json` → `history`, `evidence.json`).
- **Evidence directory:** `e2e/speech/results/aj3-run5/` (git-ignored;
  includes `logcat.txt`).

Component and unit tests (Jest) cover the same journeys against an app-owned
fake of the `HybridAiGateway` port, which is fast and runs on the host. The
device suite showed that the fake models revocation differently from the real
SDK (F1), so the device result is the one that counts.

## 2. Journey checklist

The evidence below is from the `main` run unless marked. The status column
gives `52cb23d` / `72ee323`; both runs are reported in §3 and §8.

| # | Journey | Device evidence | Status |
|---|---|---|---|
| 1 | SDK start with app policy | S02: SDK `ready`, policy `local on · node on`, package `0.1.0-m5`. The SDK starts only after unlock. | **Pass / Pass** |
| 2 | Discovery | S03: the fixture's `AJ-Study-Node` and `Kitchen-Node` were found; first result after 49 ms. | **Pass / Pass** |
| 3 | Discovery failure / permission | Android API 35 has no runtime permission for NSD, so denial cannot occur on this platform. The failure and denial UX is covered by component tests. Apple local-network denial is deferred to iOS. | Pass (UX, component) / same; iOS deferred |
| 4 | Untrusted candidates | S03: every candidate is labelled "Unverified", none is shown as paired, and a malformed (txtvers 2) announcement never appears. | **Pass / Pass** |
| 5 | QR pairing | S06: paired and Connected, "Verified with the key you paired with", `Paired · Active`. Camera scanning is deferred (ADR-015); the code text is pasted. | **Pass / Pass** |
| 6 | Expired QR | S04: `PAIRING_BOOTSTRAP_EXPIRED`, with no way to continue. An invalid code gives `PAIRING_BOOTSTRAP_INVALID`. | **Pass / Pass** |
| 7 | Verification-code confirmation | S05/S06: the app's 6-digit code equals the node's pending code. "Codes don't match" gives `PAIRING_REJECTED`, and the node keeps no pairing. | **Pass / Pass** |
| 8 | Paired / active status | S06, as above. | **Pass / Pass** |
| 9 | Secure reconnect | S13: after the node restarts, a request completes again. S15: a process restart reconnects (41 ms) to the same node identity. On `52cb23d` the status during the outage is wrong (F2); on `72ee323` it shows "Unavailable", then "Connected". | **Pass / Pass** |
| 10 | Forget and re-pair | S16: "Node forgotten. The node confirmed it removed this device." The node lists no pairing, and the next `auto` request fails with `CAPABILITY_NOT_FOUND`. Pairing again gives Connected. | **Pass / Pass** |
| 11 | Revoked trust | S17: the request fails with `NODE_TRUST_REVOKED`, which is correct. The status stays "Connected", then shows "No node paired" after a restart, with no "Forget and pair again". Recovery is possible only through the paired row's Forget. On `72ee323`: "Trust revoked", "Affected node", "Forget and pair again", then re-paired and Connected. | **Fail (F1) / Pass** |
| 12 | Spoofed / hostile candidates | S03 hides the malformed advertisement. S07 replays a used code and gets `PAIRING_SESSION_UNAVAILABLE`. S11 flags look-alikes as "Unverified · Possible impersonation" and trust is unchanged. S18 swaps an impostor onto the paired endpoint: "Identity check failed", `NODE_AUTHENTICATION_FAILED`, and the impostor obtains no pairing. | **Pass / Pass** |
| 13 | Network loss and recovery | S12 cuts Wi-Fi, data, `eth0`, the `adb reverse` route, and the live sockets. A request then fails with `NODE_UNAVAILABLE` (`node_unreachable`). After restore, a request completes again. On `52cb23d` the status still says "Connected" during the loss. On `72ee323` it says "Unavailable", then "Connected" after recovery, with no tap. | **Fail (F2) / Pass** |
| 14 | Capability request with target and reason | S08: `auto` gave target `node`, reason `only_eligible_node`, and a schema-valid result. Explicit `node` gave `explicit_node`. Explicit `local` failed with `LOCAL_CAPABILITY_UNAVAILABLE` and was never switched. No input text appears in diagnostics. | **Pass / Pass** |
| 15 | Cancel, deadline, loading, error, empty, retry | S09: Cancel gives `cancelled`, and a 5 s deadline on a held job gives `DEADLINE_EXCEEDED`. S10: with the node disabled by policy, `auto` fails and no request reaches the node. Loading, empty, and retry states are covered by component tests. | **Pass / Pass** |
| 16 | Privacy and app-lock | S01: a fresh install opens into the lock shell. S14: backgrounding relocks, an attended pairing does not survive the lock, and no pairing leaks. S19: device-log scan (§3). `FLAG_SECURE` is kept. | **Pass / Pass** |

## 3. Device results

| Step | Result | Run / emulator | Time | Notes |
|---|---|---|---:|---|
| S00 install and node | pass | 5 / 5556 | 3.4 s | |
| S01 cold launch, lock shell | pass | 5 / 5556 | 7.7 s | |
| S02 PIN, then SDK start | pass | 5 / 5556 | 81.3 s | |
| S03 discovery | pass | **3 / 5554** | 110.6 s | Not repeated on 5556 |
| S04 expired / invalid code | pass | **3 / 5554** | 103.0 s | Not repeated on 5556 |
| S05 user declines a mismatch | pass | **3 / 5554** | 125.5 s | Not repeated on 5556 |
| S06 QR pairing | pass | 5 / 5556 | 93.0 s | |
| S07 replay rejected | pass | **3 / 5554** | 146.1 s | Not repeated on 5556 |
| S08 capability requests | pass | **3 / 5554** | 205.7 s | Not repeated on 5556 |
| S09 cancel and deadline | pass | 5 / 5556 | 249.0 s | |
| S10 policy restricts routing | pass | 5 / 5556 | 141.0 s | |
| S11 spoofed candidates | pass | 5 / 5556 | 82.2 s | |
| S12 network loss and recovery | **fail** | 5 / 5556 | 276.8 s | F2. Loss and recovery themselves passed |
| S13 node interruption | **fail** | 5 / 5556 | 270.1 s | F2. Journal usable and reconnect passed |
| S14 relock on background | pass | 5 / 5556 | 92.9 s | |
| S15 process restart | pass | 5 / 5556 | 58.5 s | |
| S16 forget and re-pair | pass | 5 / 5556 | 240.0 s | |
| S17 revoked trust | **fail** | 5 / 5556 | | F1 |
| S18 wrong node identity | pass | 5 / 5556 | 71.2 s | |
| S19 device-log privacy | pass | 5 / 5556 | 0.5 s | See below |

**About this composite.**

- Steps marked **3 / 5554** passed in run 3, on the same APK, on the twin
  emulator. They were carried into run 5's checkpoint rather than repeated.
- Run 5 needed many resumed attempts, all caused by test-script defects (§5).
  The per-attempt details of S09–S15 were lost before the resume fix. Their
  pass verdicts and metrics are kept; their UI snapshots are not.
- S12 and S13 first passed with request-only checks. They were then re-run
  under the status rule (§5) with `--rerun`; the table shows the re-run.
- During S17, the AJ-0 in-memory PIN was once enrolled with a value other
  than the test PIN. The field is masked, so the cause is unknown. The app was
  force-stopped once to reset that volatile PIN, and PIN entry now checks the
  field length.
- A single clean run is still needed before AJ-3 acceptance (§9).

**S19, device-log privacy.**

- **What was scanned:** 16.5 MB from all log buffers.
- **What was looked for:**
  - every input the suite typed;
  - the pairing-code prefix, payload, and secret;
  - the test PIN, matched as a whole number.
- **Result:** none found.
- **Excluded:** uiautomator's own `AccessibilityNodeInfoDumper` lines. They are
  test-tool output that prints UI text by design.
- **Coverage on `main`:** this run predates the suite's full-run log setup, so
  the scan covered what the 2 MiB buffers still held, which is not the whole
  run. The suite now enlarges and clears the buffers at S00 and asserts that
  nothing was pruned. The AJ-1 run in §8 has full coverage.

## 4. Findings

**F1: revoked trust is not shown (S17).** Severity: medium. This is
security-relevant UX: requests fail closed and no content is exposed. Review:
`AJ3-REV-001`.

**Fixed** in `0ced9a6` (`aj1/domain-core`) and verified on the device with
`72ee323` (§8). It is not on `main` until the gated merge.

- **Observed:**
  1. The node revokes the device and closes its sockets. After 10 s the
     status shows "Connected".
  2. The next request fails with `NODE_TRUST_REVOKED`.
  3. The status still shows "Connected · Verified with the key you paired
     with · Paired · Active".
  4. After an app restart, the status shows "No node paired". A notice reads
     "This node no longer trusts this device", but offers "Reconnect". The row
     shows "Revoked · Forget".
- **Spec:** "Trust revoked" with the single recovery action "Forget and pair
  again" (UX §7.1).
- **Cause (app):**
  - `presentConnection` treats "no active record" as "No node paired".
  - The screen's revoked state requires an active record.
  - The SDK deactivates any record that is not `paired`.
  - The test fake keeps the revoked record active, so the component test
    passes.
- **Cause (SDK, read-only finding):** a request that receives
  `DEVICE_NOT_PAIRED` returns `NODE_TRUST_REVOKED`, but the trust record,
  `status()`, and the routing registry stay `paired` / `connected` until the
  next `connect()` or `refreshCapabilities()`. Code: `core/src/node_protocol.cpp`
  versus `handle_untrusted` in `core/src/pairing_node.cpp`. This differs from
  LLD §4 merge rule 6 ("Remove node targets when trust is revoked").
- **Remediation (decided):** an app fix through the public SDK API, owned by
  `hybridai-81` as a separate product commit. It must:
  - refresh or reconnect after a trust failure;
  - present the exact affected revoked or key-unavailable record;
  - offer "Forget and pair again";
  - make the test fake mirror the SDK;
  - add unit and integration tests.

  Then S17 is re-run on a packaged release APK, followed by S00–S19. The SDK
  side is backlog finding [SDK-AJ-1](hybrid-ai-sdk-issues.md); the pinned
  SDK is not patched.

**F2: the status stays "Connected" while requests fail (S12, S13).**
Severity: medium. The status misleads, but requests fail with a clear error
and reconnection works. Review: `AJ3-REV-003`.

**Fixed** in `0ced9a6` and `72ee323` (`aj1/domain-core`) and verified on the
device (§8). It is not on `main` until the gated merge.

- **Observed:** with the network path cut, or with the node stopped, a request
  fails with `NODE_UNAVAILABLE`. Thirty seconds later the status still says
  "Connected · Verified with the key you paired with".
- **Spec:** UX §7.1 has "Reconnecting…" and "Unavailable" for this.
- **Cause:** the same as F1. The app reads only `node.status()`, and the SDK
  changes it only when it next connects; a failed request does not change it.
- **Remediation (decided):** an app-side fix, scheduled with F1. For example,
  after a node request fails, call `node.connect()` and show its outcome. SDK
  side: backlog finding [SDK-AJ-2](hybrid-ai-sdk-issues.md).

**F3: duplicate "Reconnect" (S12, S13, S18).** Severity: low. The Unavailable
and identity-failure screens show two "Reconnect" buttons: the notice's own,
and the status action. It is still present in `72ee323`. `hybridai-81` will
hide the status action while the notice offers Reconnect, in a separate
commit; the final AJ-1 APK's AJ-3 regression covers it.

**F4: local requests ignore their deadline (SDK-FR-19).** Found by the load
suite; see the
[speech and load baseline](speech-and-load-baseline.md#6-hybrid-ai-sdk-local-load-suite)
and [SDK-AJ-3](hybrid-ai-sdk-issues.md).

## 5. Test-script defects found and fixed

Each of these produced a failure that was not the app's fault. Each is fixed,
and none relaxes an assertion. The list is under review as `AJ3-REV-002`.

- **A stray "V" at the start of typed text.** The AOSP keyboard turned an
  injected Shift at the start of an auto-capitalized field into "V". The
  keyboard is now disabled on test devices and re-checked before typing. The
  Diagnostics input is verified exactly before each run.
- **The emulator's `eth0` kept the network up.** Turning off Wi-Fi and data
  did not cut the path. S12 now also takes down `eth0`, the `adb reverse`
  route, and the node's live sockets.
- **Off-screen elements.** Some were not found; the suite now uses a
  two-phase scroll search.
- **Resume problems.**
  - A resume discarded earlier attempts' evidence. It is now kept, failures
    are checkpointed, and `--rerun` was added.
  - S16 is now idempotent after an interrupted forget.
  - S17 now starts from a fresh pairing.
- **Unconfirmed PIN entry.** PIN entry now verifies the masked field's
  length.
- **Assumed proactive detection.** S12, S13, and S17 assumed the status
  changes without any contact with the node. The SDK changes `status()` only
  on contact, so the suite now makes a request first. The status rule is then
  enforced after the app has seen the failure.

## 6. Development timings (not budgets)

These are from the emulator, release build. Values taken by the test script
include UI-automation time and are not product latency.

| Measure | Value |
|---|---:|
| Cold launch to the lock shell | 562 ms (run 3), 806 ms (run 5) |
| SDK start, after unlock | 21 ms (run 3), 58 ms (run 5) |
| Discovery: first result / settled | 49 ms / 56 ms |
| Secure connect after pairing | 59 ms |
| First capability event / response (`document.analyze`, node) | 20 ms / 61 ms |
| Process restart: launch / secure reconnect | 706 ms / 41 ms |

## 7. Boundaries confirmed

- **Public API only.** Only `src/platform/hybrid-ai/PackagedHybridAiGateway.ts`
  imports `@hybrid-ai/react-native`, and only its root. This is enforced by
  `unit-tests/architectureBoundaries.test.ts` and
  `unit-tests/sdkPackagePin.test.ts`.
- **No changes to the SDK repository.** No cloud, relay, account, or
  analytics dependency.
- **Discovery never creates trust.** Node names are shown bidi-isolated and
  stripped of control characters. Pairing codes are never logged or kept after
  use.

## 8. AJ-1 builds

### 8.1 Interim regression on `94604ca` (before the fix)

One fresh, non-resumed run on hybridai-81's AJ-1 release build, as the owner
approved and Codex required for final-format evidence (`AJ3-REV-002`).

- **APK:** `app-release-94604ca.apk`, SHA-256
  `98d3ee40a87a6f928b703acc17c043523fe786247d6dabb85b54760482b3d1ab`, commit
  `94604ca`, branch `aj1/domain-core`.
- **SDK:** the same artifacts as main; the tarball integrity and AAR SHA-256
  are pinned in `94604ca`.
- **Run:**
  - `emulator-5556` (`aj-api35-4g-b`, headless), 2026-10-10 14:14–14:58 IST;
  - `--expect-persistent-pin`;
  - evidence in `e2e/speech/results/aj3-aj1-94604ca/`, including
    `run-manifest.json` with the command, hashes, and emulator profile.
- **Code difference from main:** `94604ca` changes the lock (vault PIN with
  Argon2id, biometrics), navigation, Settings, and wiring. It does not change
  the node workflow or the SDK gateway.

**Result: 17 of 20 passed. S12, S13, and S17 failed with the same defects as on
main (F1, F2). There are no AJ-1 regressions.**

| Step | Result | Time | Notes |
|---|---|---:|---|
| S00–S01 | pass | 3.4 s, 7.1 s | Cold launch to the lock shell: 800 ms |
| S02 | pass | 74.4 s | Persistent PIN setup (Argon2id), then the SDK starts in 23 ms |
| S03–S07 | pass | 59.8–115.8 s | Discovery first result 47 ms; `PAIRING_REJECTED`; `PAIRING_SESSION_UNAVAILABLE`; connect 52 ms |
| S08 | pass | 250.3 s | `only_eligible_node`; explicit local refused; first event / response 14 / 61 ms |
| S09–S11 | pass | 80.2–255.0 s | Cancel and deadline; policy gives `NO_ELIGIBLE_TARGET` / `node_policy_disabled`; spoofed candidates flagged |
| S12 | **fail** | 267.9 s | F2: "Connected" after `NODE_UNAVAILABLE` / `node_unreachable`. Recovery passed |
| S13 | **fail** | 261.3 s | F2: "Connected" after `NODE_UNAVAILABLE`. The AJ-1 Diary stayed usable, and reconnect passed |
| S14 | pass | 93.7 s | Relock on background |
| S15 | pass | 59.4 s | After process death the app asked to **unlock**, so the persistent PIN survived. Relaunch 458 ms, reconnect 71 ms |
| S16 | pass | 201.8 s | Forget confirmed by the node; re-pair |
| S17 | **fail** | 461.9 s | F1, exactly as on main. Recovery through the paired row's Forget passed |
| S18 | pass | 60.5 s | Impostor: "Identity check failed" |
| S19 | pass | 0.6 s | 9.6 MB scanned, all buffers, coverage **"run"**: cleared at S00, same boot, no buffer near full. No PIN, pairing data, or typed input |

### 8.2 Fix build `72ee323`: 20 of 20

- **APK:** `app-release-72ee323.apk`, SHA-256
  `0c1f07276d0073bb3659c6c5948912dd4fae0237b65ac376bee2032bea0d1ba8`.
  `hybridai-81` built it (R8 release) from a clean detached checkout of
  `72ee323ec8dff2c564710ae29e3d4734f4c946cd`.
- **Contents:** `94604ca` plus `dc300cd`, `0ced9a6`, and `72ee323`. The SDK
  pins are unchanged.
- **Host evidence (`hybridai-81`):** JS baseline on the same commit, with 203
  unit, 3 smoke, 85 integration, and 6 performance tests and 0 lint findings.
- **Device:** `emulator-5556`, headless, harness `ccef770`. Every report
  records its provenance (command, serial, APK and fixture hashes, AVD, build
  fingerprint).
- **Runs**, in the order `AJ3-REV-004` set:
  1. **Targeted:** a fresh run of S00, S01, S02, S06, S12, S13, and S17,
     18:38–18:53. **7 of 7 pass.** Evidence:
     `e2e/speech/results/aj3-fix-72ee323-targeted/`.
  2. **Full:** a fresh non-resumed S00–S19 with `--expect-persistent-pin`,
     18:53–19:33. **20 of 20 pass**, attempt 1, no resumed steps. Evidence:
     `e2e/speech/results/aj3-fix-72ee323-full/`.

| Check | `94604ca` | `72ee323` |
|---|---|---|
| S12: status after a request fails with the path cut | "Connected" | "Unavailable" (`NODE_UNAVAILABLE` / `node_unreachable`) |
| S12: status after recovery | not checked | "Connected", with no Reconnect tap |
| S13: status with the node stopped / after its restart | "Connected" / not checked | "Unavailable" / "Connected" |
| S17: status after `NODE_TRUST_REVOKED` | "Connected", then "No node paired" after a restart | "Trust revoked", with the affected node and "Forget and pair again" |
| S17: recovery | the paired row's Forget | "Forget and pair again", then pairing gives "Connected" |
| S15: process death | asks to unlock (persistent PIN) | asks to unlock; relaunch 460 ms, reconnect 80 ms |
| S19: device-log scan | 9.6 MB, coverage "run", clean | 10.6 MB, coverage "run", clean |

Timings for the full `72ee323` run (development figures, not budgets):

- cold launch 538 ms;
- SDK start 32 ms;
- discovery first result 50 ms;
- secure connect 58 ms;
- first event / response 19 / 66 ms.

Step times: S02 74.2 s, S08 249.3 s, S12 248.7 s, S13 247.8 s, S17 237.8 s.
The others range from 0.7 s to 186.8 s.

### 8.3 Final AJ-1 APK `6f2b36b`: merge-gate regression, 20 of 20

- **APK:** `app-release-6f2b36b.apk`, SHA-256
  `cb4ff897c085e3aef2364c760c1c243df35258a0794b7ed7e0b9f3fa477f4b7d`.
  `hybridai-81` built it from a clean checkout of `aj1/domain-core` `6f2b36b`;
  it is not merged and not pushed.
- **Contents:** the validated status fixes (`0ced9a6`, `72ee323`) plus the
  AJ-1 recorder, playback, transcription, AJB1 backup and restore, and a
  Settings screen that now scrolls.
- **Run:**
  - one fresh, non-resumed run with `--expect-persistent-pin`, 2026-10-10
    23:18–23:58 IST;
  - `emulator-5556`, headless;
  - harness `84d3b4c`, whose only change since `ccef770` scrolls Settings to
    the top before navigating;
  - attempt 1, no resumed steps, provenance complete.
- **Evidence:** `e2e/speech/results/aj3-final-6f2b36b/`.
- **Result: 20 of 20 pass.**
  - S12: "Unavailable" (`NODE_UNAVAILABLE` / `node_unreachable`), then
    "Connected" after recovery.
  - S13: "Unavailable" with the node stopped, then "Connected"; the Diary
    stayed usable.
  - S15: the persistent PIN asks to unlock after process death.
  - S17: "Trust revoked" with "Forget and pair again".
  - S18: "Identity check failed".
  - S19: 11.6 MB scanned, coverage "run", clean.
- **Timings (development figures):**
  - cold launch 634 ms;
  - SDK start 33 ms;
  - discovery first result 31 ms;
  - connect 52 ms;
  - first event / response 27 / 80 ms;
  - process restart 636 ms, reconnect 85 ms.

## 9. Limitations and remaining work

- `main` keeps F1 and F2 until `aj1/domain-core` is merged. The merge-gate
  regression on `6f2b36b` has passed (§8.3).
- F3 (duplicate "Reconnect") is to be re-checked when `hybridai-81`'s change
  lands.
- AJ-3 milestone exit: needs AJ-1 and AJ-2 (organize through
  `journal.organize@1`, minimum transcript content sent).
- Camera QR scanning is deferred (ADR-015).
- Apple local-network permission denial and all iOS validation are deferred.
  They are not passed.
- No physical `arm64-v8a` device has been used.
- Network loss is simulated by cutting the emulator's networks, the
  `adb reverse` route, and the live sockets. This is not a radio cut.

## 10. Reproduction

```sh
npm install --install-links       # packaged SDK tarball (see package.json)
(cd android && ./gradlew :app:assembleRelease)
(cd e2e/android/nsd-fixture && ../../../android/gradlew assembleDebug)
export ANDROID_SERIAL=emulator-5556   # one suite per emulator
node e2e/android/aj3-e2e.mjs --apk android/app/build/outputs/apk/release/app-release.apk --out <dir>
node e2e/android/aj3-e2e.mjs --apk <apk> --resume --out <dir>              # continue after a failure
node e2e/android/aj3-e2e.mjs --apk <apk> --resume --only S00,S12 --rerun S12 --out <dir>
# AJ-1 builds keep the PIN across restarts:
node e2e/android/aj3-e2e.mjs --apk <aj1.apk> --expect-persistent-pin --out <dir>
```
