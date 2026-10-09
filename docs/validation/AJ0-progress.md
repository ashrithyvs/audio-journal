# AJ-0 Progress Validation

**Date:** 2026-10-09  
**App baseline:** uncommitted working tree on `f7563cf`  
**Installed SDK JS snapshot:** `@hybrid-ai/react-native` `0.1.0-m4`

## Implemented checkpoint

- React Native 0.87 TypeScript application with New Architecture enabled.
- Lock-gated Diary, Organized, Tasks, and Settings navigation shell.
- Pure lock reducer plus credential and biometric ports.
- Volatile, non-production credential adapter and unavailable-biometric adapter.
- First-run PIN setup, PIN unlock, biometric failure/cancel fallback, manual lock,
  lifecycle relock, and fail-closed adapter errors.
- Cross-platform privacy curtain and Android `FLAG_SECURE`.
- Public-root Hybrid AI gateway adapter and initialization status surface.
- Independent Jest projects for unit, smoke, integration, and performance tests.

No journal persistence, recording, content, secure credential persistence, or
production biometric mechanism is implemented.

## Passing evidence

`npm run test:baseline`:

- TypeScript no-emit: pass.
- ESLint: pass with zero warnings/errors.
- Unit: 12/12.
- Component smoke: 1/1.
- Integration: 4/4.
- Performance: 1/1; 1,000 three-transition lock cycles keep p95 below the
  development-only 1 ms threshold on this host.

Android debug assembly, after installing platform API 36:

```text
source ../hybridAi/tools/android-env.sh
cd android
./gradlew :app:assembleDebug --console=plain
```

Result: `BUILD SUCCESSFUL`; the application, Hybrid AI Android binding,
TurboModule, React Native Screens, and safe-area native modules compiled. The
debug APK was produced. This proves native assembly, not a runnable JS/device
smoke test.

The SDK's Android Gradle module is a live sibling-project reference required by
the current package layout. This build occurred while the sibling repository
was at `27cc99c` with Claude's uncommitted M5.2 binding work present. It is useful
compatibility evidence, but not a reproducible G4 or M5.2 acceptance baseline.

## Blocking failure

The production Android Metro bundle fails while resolving the public SDK root:

```text
npx react-native bundle --platform android --dev false --entry-file index.js \
  --bundle-output /tmp/audio-journal-aj0.android.bundle
```

The installed `@hybrid-ai/react-native` snapshot declares `source`/`types` but no resolvable `main`,
`react-native`, or `exports` entry. Metro falls back to `index`, which does not
exist. The package's React Native configuration also reports that
`dependency.platforms.ios.podspecPath` is invalid for the installed CLI.

The app does not work around this with a private/source import because that
would violate ADR-010. The SDK package must expose its public `src/index.ts`
through supported package metadata (and correct its iOS autolinking metadata),
then be reinstalled and the bundle/device smoke rerun.

## Remaining AJ-0 gate work

1. Receive/reinstall a corrected packaged SDK artifact after M5.2.
2. Pass Metro release-style bundling and run the app on the API 35 emulator.
3. Verify native SDK initialization and lock/navigation smoke on-device.
4. Accept the security ADR, then replace the volatile lock and biometric stubs;
   persistent security behavior is not part of this checkpoint.
5. Compile and validate the iOS scaffold when macOS/Xcode is available.

The npm install reported transitive audit findings and one test-renderer peer
warning. Dependency/security triage remains an AJ-4 release task unless a
runtime-impacting defect appears earlier.
