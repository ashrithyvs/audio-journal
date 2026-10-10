# AJ-3 Android Validation: Secure Private AI Node Workflow

**Status: AJ-3 is NOT yet passed.**

- The implementation is complete and its component tests pass.
- Device validation is partial:
  - **S00–S08 passed** on the R8 release build against the packaged SDK and
    the reference node.
  - **S09–S19 have not passed yet.** They are blocked by a test-script input
    issue (section 6), not by an app failure.
- The milestone exit "create and organize an entry" also depends on AJ-1 and
  AJ-2, which are not complete (roadmap §5).

**Date:** 2026-10-10.
**App:** `52cb23d`, release APK with R8. Its product code equals the AJ-3
implementation in `58d8f94`, plus speech work that does not touch the node
workflow. Test scripts: `7eb8d2e`.

**SDK (packaged; public API only):**

| Artifact | Version / source | SHA-256 |
|---|---|---|
| `hybrid-ai-react-native-0.1.0-m5.tgz` | built from `e0fc3c5` (G5-A `07a8bf7`) | `4761ea3b7fa29b34256fcb03f201b24bd69cf05a59c300b469e82338cafd8b74` |
| `hybrid-ai-android-release.aar` | built from `e0fc3c5` | `ed8ee30c95ce6c30dbea0d4bb98f7003929a5249d2c76defc2fd8cbfe1ed3579` |

The tarball's SHA-512 matches `package-lock.json`. The AAR's SHA-256 is
checked at every build (`android/hybrid-ai-android`). ABIs are `arm64-v8a`
and `x86_64`.

**Reference node:** the SDK repository's `reference-node/src/paired.mjs` at
`07a8bf7` (unchanged since `e0fc3c5`). It runs as an external process and is
reached through `adb reverse`; only its loopback operator API is used.

**Environment:**

- Emulator `aj-api35-4g` (API 35 x86_64, 4 GB, 4 vCPU, software GPU).
- Host: Linux x86_64, Node.js 22.22.1.
- The SDK-profile AVD `hybrid-ai-api35-net` (2 GB) was used for earlier
  runs.
- No physical device has been used. iOS is deferred.

## 1. How it was tested

The device suite `e2e/android/aj3-e2e.mjs` drives the real release app with
`adb` and `uiautomator`. Its selectors are React Native `testID`s.

- **Evidence is UI-hierarchy text.** `FLAG_SECURE` blocks screenshots by
  design.
- **The operator role is real.** The suite issues QR codes, reads the node's
  pending verification code, approves pairings, revokes them, and drops
  connections through the reference node's operator API.
- **Discovery uses a test-only fixture APK.** It advertises services through
  Android's public `NsdManager` and contains no SDK code.

Component and unit tests (Jest) cover the same journeys against an app-owned
fake of the app's `HybridAiGateway` port: 24 integration and 114 unit tests
pass at `52cb23d`.

## 2. Journey checklist

| # | Journey | Device evidence | Component tests | Status |
|---|---|---|---|---|
| 1 | SDK start with app policy | S02: SDK `ready`, policy `local on · node on`, package `0.1.0-m5`. The SDK starts only after unlock (AJ-FR-035). | yes | **Pass** |
| 2 | Discovery of nodes | S03: the fixture's `AJ-Study-Node` and `Kitchen-Node` were found within about 5 s. | yes | **Pass** |
| 3 | Discovery failure / permission | API 35 has no local-network permission for NSD, so on-device denial is **platform-not-applicable and deferred to Apple validation**. The failure and denial UX (`DISCOVERY_PERMISSION_DENIED`, `DISCOVERY_FAILED`, retry) is covered by component tests. | yes | Pass (UX); device N/A |
| 4 | Untrusted candidates | S03: every candidate is labelled "Unverified", none is shown as paired, and a malformed (txtvers 2) announcement never appears. | yes | **Pass** |
| 5 | QR pairing via public API | S06: paired and **Connected**, "Verified with the key you paired with", `Paired · Active`. | yes | **Pass** |
| 6 | Expired QR rejected | S04: `PAIRING_BOOTSTRAP_EXPIRED`, with no way to continue. An invalid code gives `PAIRING_BOOTSTRAP_INVALID`. | yes | **Pass** |
| 7 | Verification-code confirmation | S05/S06: the app's 6-digit code equalled the node's pending code (`046314`, `786850`). A decline gives `PAIRING_REJECTED`, and the node keeps no pairing. | yes | **Pass** |
| 8 | Paired / active status | S06, as above. | yes | **Pass** |
| 9 | Secure reconnect | Planned in S13 (node restart) and S15 (process restart). Re-pairing runs logged reconnect times of 59 ms (S06/run 3). | yes | Pending (device) |
| 10 | Forget and re-pair | S16 | yes | Pending (device) |
| 11 | Revoked trust | S17 | yes | Pending (device) |
| 12 | Spoofed / hostile candidates | S03 hides the malformed advertisement. S07 replays a used code and gets `PAIRING_SESSION_UNAVAILABLE`, with the node's pairings unchanged. S11 (impersonation flags) and S18 (impostor identity on the paired endpoint) are still to run. | yes | Partial |
| 13 | Network loss and recovery | S12 | yes | Pending (device) |
| 14 | Capability request with target and reason | S08: `auto` gave target `node`, reason `only_eligible_node`, and a schema-valid result. Explicit `node` gave `explicit_node`. Explicit `local` gave `LOCAL_CAPABILITY_UNAVAILABLE`: the explicit target was never switched. No input text appears in diagnostics. | yes | **Pass** |
| 15 | Cancel, deadline, loading, error, empty, retry | S09/S10 on device are blocked (section 6). Component tests cover cancel, deadline selection, typed failures with retry, empty discovery, and loading states. | yes | Partial |
| 16 | Privacy and app-lock still working | S01 opens a fresh install into the lock shell. Background relock (S14) and the log-privacy scan (S19) are still to run. `FLAG_SECURE` is retained. | yes | Partial |

## 3. Device results

| Step | Run 3 (`aj3-run3`) | Notes |
|---|---|---|
| S00 install and node | pass (2.0 s) | |
| S01 cold launch, lock shell | pass (7.2 s) | |
| S02 PIN, then SDK start | pass (61.8 s) | |
| S03 discovery | pass (110.6 s) | |
| S04 expired / invalid code | pass (103.0 s) | |
| S05 user declines a mismatch | pass (125.5 s) | |
| S06 QR pairing | pass (145.7 s) | Run 4: 69.9 s with pasted codes (`7eb8d2e`) |
| S07 replay rejected | pass (146.1 s) | |
| S08 capability requests | pass (205.7 s) | |
| S09–S19 | not passed | Section 6 |

Earlier runs failed only on test-script defects, and each was fixed:

- uiautomator idle races;
- a reused keep-alive socket in the operator client;
- a pairing code expiring while it was being typed;
- dropped characters with long `input text` strings;
- multiline field clearing.

## 4. Development timings (not budgets)

Emulator, release build:

| Measure | Value |
|---|---:|
| Cold launch to the lock shell | 562 ms (run 3), 500 ms (run 4) |
| SDK start (after unlock) | 21–27 ms |
| Discovery: first result / settled | 49 ms / 56 ms (from session start; NSD on device) |
| Secure connect after pairing | 59 ms |
| First capability event / response (`document.analyze`, node) | 20 ms / 61 ms |
| Pairing wall time, harness end to end | 48–124 s, dominated by test automation; the app-side ceremony itself is sub-second |

## 5. Boundaries confirmed

- **Public API only.** Only `src/platform/hybrid-ai/PackagedHybridAiGateway.ts`
  imports `@hybrid-ai/react-native`, and only its root. No SDK source, private
  header, native module, or working-tree path is used. This is enforced by
  `unit-tests/architectureBoundaries.test.ts` and
  `unit-tests/sdkPackagePin.test.ts`.
- **No changes to the SDK repository.** No cloud, relay, account, or
  analytics dependency.
- **Discovery never creates trust.** Node names are shown bidi-isolated and
  stripped of control characters. Pairing codes are never logged or kept
  after use.

## 6. Open item blocking S09–S19

S09 needs the reference node's hold fixture input (`__fixture_hold__`) in the
Diagnostics field.

- **Typing it.** On this emulator, injecting text that starts with `_`
  produces a stray leading `V` (`V__fixture_hold__`).
- **Pasting it.** Clipboard paste works in the single-line pairing field but
  did not set the multiline Diagnostics field exactly.
- **Effect.** The suite now verifies the field's exact text and stops
  instead of producing a false result.
- **Next step.** Diagnose the paste and key-injection behaviour on the
  device, then resume S09–S19 from the checkpoint (the suite supports
  `--resume`).

## 7. Limitations and deferred work

- Camera QR scanning is deferred (ADR-015); codes are pasted or entered.
- Apple local-network permission denial is deferred to the iOS profile.
- Physical `arm64-v8a` validation and iOS validation have not been done.
- Network-loss tests run over `adb reverse`, so they exercise the
  ConnectivityManager-driven reconnect, not a physical radio cut (the same
  limitation as G5-A).

## 8. SDK defects found

**Local requests ignore their deadline** (SDK-FR-19), found by the load
suite. The details are in
[the speech and load baseline](speech-and-load-baseline.md#6-hybrid-ai-sdk-local-load-suite).
No defect was found in the discovery, pairing, trust, or routing APIs that
this suite exercised.

## 9. Reproduction

```sh
npm install --install-links       # packaged SDK tarball (see package.json)
(cd android && ./gradlew :app:assembleRelease)
(cd e2e/android/nsd-fixture && ../../../android/gradlew assembleDebug)
node e2e/android/aj3-e2e.mjs --apk android/app/build/outputs/apk/release/app-release.apk --out <dir>
node e2e/android/aj3-e2e.mjs --apk <apk> --resume --out <dir>   # continue after a failure
```
