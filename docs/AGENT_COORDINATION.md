# Agent Coordination

Operational shared memory for ChatGPT Work/Codex, Cursor, and human contributors.
Permanent decisions belong in the canonical documents linked from `README.md`.

## Current snapshot

- **Phase:** AJ-0 documentation and repository foundation.
- **Branch:** `main` after Git initialization.
- **Last agent:** Codex.
- **Last updated:** 2026-10-09.
- **Active claim:** none after this handoff.
- **Implementation status:** AJ-0 checkpoint implemented but not accepted.
  JavaScript tests and Android native assembly pass; SDK Metro packaging,
  device smoke, production credentials/biometrics, and iOS remain open.

## Completed

- Created the Audio Journal product repository and canonical documentation set.
- Initialized a local Git repository on branch `main`; no commit or remote was
  created because neither was requested.
- Captured the frozen local/private-first, no-account, app-lock, source-of-truth,
  diary/organized-mode, live-transcription, and Hybrid AI boundary decisions.
- Added the proposed “Quiet Archive” visual direction: warm paper/moss palette,
  editorial date/title hierarchy, bottom navigation, core screen compositions,
  component inventory, failure states, and visual acceptance criteria.
- Corrected the UI model to expose explicit Diary and Organized views, including
  Work and Personal sections, and made exact transcript/audio-range provenance
  a mandatory, playable reference for every voice-derived task.
- Added user-controlled portable encrypted backup and empty-vault restore for
  app-data clear/reinstall recovery. The archive includes journal content and
  provenance but excludes PIN/biometric/device keys and node pairing credentials.
- Preserved the interactive UI/UX design inside `docs/design/` as an editable
  fragment plus a standalone browser-ready HTML review file. The prototype now
  includes Backup & restore states.
- Marked encryption mechanics, exact audio/STT integration, capability schemas,
  portable-backup cryptographic/container details, retention, and destructive
  recovery details as open where not yet approved.
- Generated the React Native 0.87 TypeScript/New-Architecture native scaffold
  without modifying the sibling SDK repository.
- Added lock-gated Diary/Organized/Tasks/Settings navigation, replaceable lock
  and biometric ports, a volatile scaffold verifier, lifecycle relock, privacy
  curtain, Android `FLAG_SECURE`, and a public-root Hybrid AI adapter.
- Added separate unit, component-smoke, integration, and performance Jest
  projects plus one-command baseline validation.
- Reconciled React Native's compile API 36 requirement with SDK min API 26 and
  target API 35, and recorded the exact AJ-0 dependency profile in canonical docs.

## Next work

1. Have the SDK M5.2 work expose a valid Metro/public package entry and correct
   the CLI-invalid iOS autolinking metadata, then reinstall the package.
2. Rerun the Metro bundle and API 35 emulator smoke, including real SDK initialization.
3. Resolve the pre-implementation security ADR covering database and recording
   encryption, PIN KDF/key wrapping, biometric key invalidation, and local reset.
4. Replace the volatile credential and unavailable-biometric adapters only after
   that security decision, then complete AJ-0 device lock tests.
5. Resolve the audio/STT pipeline ADR and freeze `journal.organize@1` schemas before AJ-1/AJ-2.

## Validation

- `npm run test:baseline` passed: typecheck, zero-warning lint, 12 unit,
  1 component smoke, 4 integration, and 1 performance test.
- Android `:app:assembleDebug` passed against the SDK native binding after API
  36 was installed; it produced a debug APK but did not prove JS runtime startup.
  The native module came from live SDK HEAD `27cc99c` plus uncommitted M5.2 work,
  so this is compatibility evidence rather than an accepted SDK baseline.
- Production-style Metro bundling failed because `@hybrid-ai/react-native`
  0.1.0-m4 has no resolvable JS package entry. Full evidence and the exact
  rerun commands are in `docs/validation/AJ0-progress.md`.
- Documentation validation passed for 17 Markdown files: balanced code fences,
  existing relative link targets, and 46 unique requirement/business-rule IDs.
- Trailing-whitespace scan passed. Git root and branch resolve to this repository
  and `main`; all created files remain untracked in the new repository.
- The interactive “Quiet Archive” UI concept was rendered and visually checked
  at 736×1000 and 360×900. It is a design reference, not application code.
- The revised Organized screen and exact task-source playback screen were
  separately rendered and visually checked at 736×1000 and 360×900.
- The Backup & restore screen was rendered and visually checked at 360×900.

## Known constraints

- Hybrid AI SDK v0.1 is still progressing in the sibling repository.
- The local Hybrid AI dependency is a development file link, not a releasable
  pinned artifact. Its native Android graph assembles, but its JS package does not bundle.
- The AJ-0 credential verifier is deliberately volatile and non-cryptographic;
  it must never be described or shipped as production app-lock storage.
- iOS validation requires macOS/Xcode and remains a future execution dependency.
- No remote is configured for this repository unless a later task explicitly adds one.
