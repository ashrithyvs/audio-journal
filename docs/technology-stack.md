# Audio Journal Application Technology Stack

**Status:** Android application baseline implemented and validated through the
recorded AJ-1–AJ-4-P/AJ-2 gates; AJ-RI migration is pending. Equivalent iOS
adapters/packages remain required and unverified until `GRI-6-I`.

## 1. Frozen foundation

| Area | v0.1 direction | Status |
|---|---|---|
| Application | React Native + TypeScript | Frozen |
| Native architecture | React Native New Architecture / TurboModules / JSI | Frozen |
| Runtime style | Native development builds; Expo Go is not a target | Frozen |
| Navigation | React Navigation | Implemented Android; iOS unverified |
| Transient state | React contexts, feature controllers, and component state; no external store package | Implemented |
| Durable data | SQLCipher behind TypeScript repository interfaces and a native module | Implemented Android; iOS adapter required |
| Audio files | Encrypted AJR1 in app-private storage, referenced from SQLCipher | Implemented Android; iOS adapter required |
| Recording | Application-owned `RecordingService`; native Android AudioRecord/playback adapter | Implemented Android; iOS adapter required |
| AI | Version-pinned packaged Hybrid AI React Native API | Frozen |
| Contracts | Versioned JSON Schema for application-owned capabilities | Frozen |
| Secrets | Android Keystore-backed native vault; Apple Keychain/Secure Enclave adapter required | Implemented Android; iOS unverified |
| Biometrics | AndroidX BiometricPrompt with PIN fallback; Apple platform equivalent required | Implemented Android; iOS unverified |

The mobile application supports Android and iOS. Android is currently the
executable development profile; this does not narrow the frozen application
scope. Native iOS dependencies, packaging, and runtime behavior remain
unverified until the macOS/Xcode `GRI-6-I` catch-up gate.

This document owns the application stack only. The production Private AI Node
is the SDK product's native C++20/CMake service plus operator CLI for Linux,
Windows, and macOS. Its networking, TLS, model runtime, service adapters,
credential storage, and packaging are frozen by SDK ADR-025 and the
SDK [technology stack](../../hybridAi/docs/technology-stack.md). Audio Journal does
not embed, fork, or select a node-server framework.

Expo modules may be used inside native development builds where they meet the
security, encryption, performance, and platform requirements. The architecture
must not depend on Expo Go.

## 2. Implemented Android choices and iOS parity work

| Concern | Implemented Android choice | iOS status |
|---|---|---|
| Database | `sqlcipher-android` 4.19.1 + AndroidX SQLite 2.7.0 behind the native store module | Equivalent SQLCipher-backed adapter and migration/round-trip evidence required |
| Domain access | Thin TypeScript repositories over explicit native SQL operations | Shared repositories remain; native adapter unverified |
| Vault/PIN | Native Kotlin vault, P-H-C libargon2 20190702, Android Keystore wrapping | Keychain/Secure Enclave design exists; implementation/evidence required |
| Biometrics | AndroidX Biometric 1.1.0, `BIOMETRIC_STRONG`, cryptographic prompt and PIN fallback | LocalAuthentication/Keychain equivalent required without raw biometric access |
| Recording/playback | Native Kotlin module, AudioRecord/audio playback, AJR1 encrypted frames | Native Apple audio adapter required |
| Backup/restore | Native AJB1 codec and system document picker flow | Apple document picker and cross-platform AJB1 round-trip required |
| Unit/UI tests | Jest 29.6 + React Native Testing Library 14.1; JUnit 4.13.2 for native units | Shared JS suites plus XCTest/native coverage required |
| Device E2E | Repository-owned Node.js 22 driver over adb/uiautomator | XCUITest or equivalent native iOS harness must be selected and pinned at `GRI-6-I` |

Expo Go, Expo SQLite, Expo SecureStore, Expo LocalAuthentication, Zustand,
Detox, and Maestro are not dependencies in the implemented Android baseline.
Introducing one later requires an ADR and affected security/performance tests.

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
| AJB1 reference and vectors | `tools/ajb1-reference` (Node 22, dependency-free; independent Argon2id checked against RFC 9106) | Frozen and implemented by ADR-017; physical low-end-device production KDF profile remains open |
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

## 4. Historical selection spikes and remaining parity gates

1. The Android packaged-SDK consumer, vault/biometrics, SQLCipher, recording,
   backup, and device harness spikes are complete as recorded by their reports.
2. AJ-RI-2 removes the historical app-owned whisper runtime and consumes
   packaged SDK `audio.transcribe@1` without changing recording ownership.
3. `GRI-6-I` selects/pins the remaining iOS-native packages and proves secure
   storage, biometrics, SQLCipher migration/round-trip, audio, backup, lifecycle,
   device E2E, and packaged SDK behavior.
4. Physical Android production KDF, thermal, battery, and low-memory budgets
   remain separate deferred certification work.
