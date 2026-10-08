# Agent Coordination

Operational shared memory for ChatGPT Work/Codex, Cursor, and human contributors.
Permanent decisions belong in the canonical documents linked from `README.md`.

## Current snapshot

- **Phase:** AJ-0 documentation and repository foundation.
- **Branch:** `main` after Git initialization.
- **Last agent:** Codex.
- **Last updated:** 2026-10-08.
- **Active claim:** none after this handoff.
- **Implementation status:** not started; documentation only.

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

## Next work

1. Review and approve or amend the frozen decisions and open questions.
2. Resolve the pre-implementation security ADR covering database and recording
   encryption, PIN KDF/key wrapping, biometric key invalidation, and local reset.
3. Resolve the audio/STT pipeline ADR and freeze `journal.organize@1` schemas.
4. Begin AJ-0 scaffolding only after the design review is accepted.

## Validation

- Documentation-only change; no application build or runtime tests exist yet.
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
- iOS validation requires macOS/Xcode and remains a future execution dependency.
- No remote is configured for this repository unless a later task explicitly adds one.
