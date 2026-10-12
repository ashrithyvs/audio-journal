# Technology Stack

**Status:** Foundation frozen. AJ-0 packages below are pinned and validated;
persistence, credential, biometric, audio, and device-E2E packages remain Open.

## 1. Frozen foundation

| Area | v0.1 direction | Status |
|---|---|---|
| Application | React Native + TypeScript | Frozen |
| Native architecture | React Native New Architecture / TurboModules / JSI | Frozen |
| Runtime style | Native development builds; Expo Go is not a target | Frozen |
| Navigation | React Navigation | Target |
| Transient state | Zustand for UI/session/recorder/playback/AI operation state | Target |
| Durable data | SQLite behind repository interfaces | Frozen boundary |
| Audio files | App-private filesystem, referenced from SQLite | Frozen boundary |
| Recording | App-owned `RecordingService` with native-capable implementation | Frozen boundary |
| AI | Version-pinned packaged Hybrid AI React Native API | Frozen |

The mobile application supports Android and iOS. Android is currently the
executable development profile; this does not narrow the frozen application
scope. Native iOS dependencies, packaging, and runtime behavior remain
unverified until the macOS/Xcode `GRI-6-I` catch-up gate.
| Contracts | Versioned JSON Schema for application-owned capabilities | Frozen |
| Secrets | Platform Keychain/Keystore-backed adapter | Frozen boundary |
| Biometrics | Platform biometric prompt; result only, no raw data | Frozen behavior |

Expo modules may be used inside native development builds where they meet the
security, encryption, performance, and platform requirements. The architecture
must not depend on Expo Go.

## 2. Candidate package decisions

These are candidates, not approvals:

| Concern | Candidate | Decision gate |
|---|---|---|
| SQLite | `expo-sqlite` or another New-Architecture-compatible binding | Must satisfy approved encryption, WAL/migration, backup, and performance requirements. |
| Database access | Thin typed repositories over explicit SQL; Drizzle only if it preserves migration/control needs | Evaluate after schema/encryption ADR. |
| Secure values | `expo-secure-store` or a narrow native Keychain/Keystore adapter | Must support required key accessibility, invalidation, backup exclusion, and native builds. |
| Biometrics | `expo-local-authentication` or narrow native platform adapters | Must expose OS result only and reliable PIN fallback/enrollment-change behavior. |
| Audio | Existing maintained native-capable RN library or project native module | Must meet continuous capture, pause/resume, frames, interruptions, recovery, and memory tests. |
| Unit/component tests | Jest or Vitest plus React Native Testing Library | Select one runner based on RN/toolchain compatibility. |
| Device E2E | Detox or Maestro-style device workflow | Must cover native permissions, backgrounding, lock, recording, and process restart. |

No candidate package is frozen merely because it appears here. Pin exact versions
and licenses only after compatibility/security spikes against the supported
Android/iOS and Hybrid AI package matrix.

### AJ-0 pinned application profile

| Concern | Pinned version | AJ-0 evidence |
|---|---:|---|
| React / React Native | 19.2.3 / 0.87.0 | Typecheck, Jest suites, Android debug assembly |
| React Navigation | native 7.5.0; bottom-tabs/native-stack 7.20.0 | Lock-gated four-tab integration test |
| Screens / safe area | 4.28.0 / 5.10.1 | New-Architecture Android compilation |
| TypeScript | template-compatible 6.0.x | Strict no-emit check |
| Jest / RN Testing Library | 29.6.x / 14.1.0 | Separate unit, smoke, integration, and performance projects |
| Hybrid AI React Native | `hybrid-ai-react-native-0.1.0-m5.tgz` (SDK `c4b302e`, accepted and merged into SDK `main` by `855edaf`; previously `e0fc3c5`), SHA-256 `a11cba67…e2a` | Metro release bundle, R8 release APK, API 35 device suite ([AJ-3](validation/AJ3-android.md)) |
| Hybrid AI Android AAR | `hybrid-ai-android-release.aar` (SDK `c4b302e`, accepted and merged into SDK `main` by `855edaf`; previously `e0fc3c5`), SHA-256 `8751a5a7…b1a`, via `android/hybrid-ai-android` wrapper | Build-time SHA-256 check; `arm64-v8a` and `x86_64` only |
| Argon2id | P-H-C reference libargon2 `20190702` (`62358ba2`, archive SHA-256 `daf972a8…442c`), native (ADR-017) | Planned for AJ-1; parameters pending a low-end device benchmark |
| Encrypted database | `net.zetetic:sqlcipher-android:4.19.1` + `androidx.sqlite:sqlite:2.7.0` (ADR-017) | AJ-1 |
| PIN and AJB1 KDF | P-H-C reference libargon2 `20190702` (`62358ba2`), archive SHA-256 `daf972a8…442c`, built by `android/vault-crypto` (ADR-017) | Vault JVM tests; the device benchmark is Open |
| Biometric prompt | `androidx.biometric:biometric:1.1.0` (`BIOMETRIC_STRONG`, `CryptoObject` only) | AJ-1 |
| Native unit tests | JUnit 4.13.2 (JVM; vault core) | `./gradlew :app:testDebugUnitTest` |
| AJB1 reference and vectors | `tools/ajb1-reference` (Node 22, dependency-free; independent Argon2id checked against RFC 9106) | Proposed format, not frozen |
| Historical AJ-owned transcription | whisper.cpp v1.9.5 (`d1be6fde`), `base.en-q5_1` / `tiny.en-q5_1` (ADR-016) | Implemented pre-RI baseline; must be removed from the app by AJ-RI-2 |
| Target transcription and organization runtimes | Version-pinned packaged Hybrid AI SDK providers and exact model profiles (ADR-021) | RI-2/RI-3/RI-4; the app owns no runtime or model artifact |
| Private-node network profile | Stock Tailscale clients installed independently on Android and the Linux/Windows/macOS node host | Linux/Ubuntu is validated first; no AJ/SDK library or control-plane dependency |
| Android device E2E | Node.js 22 driver over `adb` + `uiautomator` (`e2e/android/`), no third-party framework | AJ-3 device suite (ADR-015) |

Android uses min API 26 and target API 35 to match the accepted SDK profile.
React Native 0.87's AndroidX Core dependency requires compile API 36; compile SDK
is therefore 36 without raising the runtime floor or target behavior. The SDK
library itself retains its configured compile API 35.

## 3. Dependency rules

- Prefer small replaceable adapters around audio, database, secure storage,
  biometric, filesystem, and Hybrid AI dependencies.
- Do not let package-specific objects cross into domain records or repositories.
- Pin native dependencies and document license/provenance before release.
- Reject libraries that require public backend accounts, upload journal content,
  inject advertising/analytics, or cannot exclude sensitive telemetry.
- Record platform support, New Architecture status, binary size, maintenance,
  security history, and test evidence for each selected dependency.

## 4. Selection spikes before AJ-0/AJ-1

1. Build a minimal native React Native consumer of the packaged Hybrid AI SDK.
2. Verify candidate secure-storage/biometric behavior across enrollment changes,
   process restart, device lock state, and backup/restore.
3. Verify the chosen SQLite encryption build and migration path on both platforms.
4. Record uninterrupted and interrupted audio while streaming bounded frames;
   measure loss, memory, battery, file recovery, and playback.
5. Confirm that test tooling can automate lock, permission, recording, background,
   process-death, and node-unavailable scenarios on the supported matrix.
