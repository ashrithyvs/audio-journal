# Audio Journal

Audio Journal is a private, local-first voice and written journal with optional
organization and task extraction powered through the Hybrid AI SDK.

The product is a journal first. AI is secondary and must not obstruct capture,
change source material, or become a prerequisite for reading past entries.

```text
Original audio or written entry
              |
              v
     Timestamped transcript
              |
              v
 Optional derived organization
              |
              v
 Tasks, ideas, people, projects, work, personal
```

The original recording or written entry is always authoritative. Every derived
item must retain provenance back to the entry, transcript segment, and audio
time range where applicable.

## Status

**AJ-0 foundation in progress.** The repository now contains a React Native
0.87 TypeScript/New-Architecture application, navigation shell, replaceable
app-lock ports, a volatile development lock adapter, privacy curtain, Android
screenshot protection, a public Hybrid AI package adapter, and separated test
suites.

The current lock adapter is intentionally not persistent and makes no
production security claim. PIN KDF/key wrapping, secure storage, biometric
invalidation, retry/backoff, and reset behavior remain blocked on the security
ADR. The SDK native Android graph compiles, but the SDK package currently lacks
a resolvable JavaScript entry point, so Metro bundling and device smoke remain
open. See [AJ-0 validation](docs/validation/AJ0-progress.md).

The documents under `docs/` define the intended v0.1 product, architecture,
security posture, UX, data model, integration boundary, and delivery gates.
Items marked **Open** must be resolved before the affected implementation begins.

## Frozen product principles

- Local/private-first; no public cloud execution path.
- No account, sign-up, or sign-in.
- Local PIN/passcode lock with optional biometric convenience unlock.
- Raw biometric data is never read, stored, logged, or transmitted.
- Diary mode preserves raw entries without forced analysis.
- Organized mode is explicit and produces views over source material.
- Recording persistence is independent from live transcription and AI.
- The app works without a Private AI Node; node-assisted organization is optional.
- Hybrid AI is consumed only through its public packaged APIs.

## Documentation

Start with the [documentation index](docs/README.md). Canonical decisions live
in [architecture decisions](docs/architecture-decisions.md), while operational
handoff state lives in [agent coordination](docs/AGENT_COORDINATION.md).

The interactive UI/UX design can be opened directly from
[`docs/design/audio-journal-ui-prototype.html`](docs/design/audio-journal-ui-prototype.html).

The sibling SDK repository is expected at:

`/home/igdclt0603/Desktop/Ash/hybridAi`

That path is a development convenience, not a runtime dependency or permission
to import SDK source directly.

## Development

```text
npm install --install-links
npm run test:baseline
source ../hybridAi/tools/android-env.sh
cd android && ./gradlew :app:assembleDebug --console=plain
```

The local SDK package link is development-only and must be replaced by a
versioned publishable artifact before release.
