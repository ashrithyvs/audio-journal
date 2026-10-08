# Technology Stack

**Status:** Foundation frozen; concrete packages and versions marked Open require
verification before the first implementation commit.

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
