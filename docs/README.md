# Documentation Index

## Status language

- **Frozen:** approved v0.1 behavior. Changing it requires an ADR update.
- **Target:** intended design whose implementation has not begun.
- **Open:** decision required before affected implementation starts.
- **Future:** deliberately outside v0.1; not an implied commitment.
- **Implemented:** reserved for behavior supported by repository and validation evidence.

AJ-0 scaffold behavior may be described as implemented only when backed by
[AJ-0 validation evidence](validation/AJ0-progress.md). Production credential
storage, biometrics, journal persistence, recording, and AI journeys remain
targets rather than implemented behavior.

Audio Journal targets both Android and iOS. Android-first describes the current
validation order, not the supported-product boundary. iOS remains in scope and
must pass cumulative `GRI-6-I` and the SDK's deferred iOS profiles before any
cross-platform mobile or v0.1 release claim.

## Canonical documents

- [Architecture decisions](architecture-decisions.md) — frozen decisions and open ADRs.
- [Scope and requirements](scope-and-requirements.md) — v0.1 boundaries and traceable requirements.
- [Business use cases](business-use-cases.md) — actors, user value, and business rules.
- [High-level design](high-level-design.md) — system context, containers, and major flows.
- [Low-level design](low-level-design.md) — domain model, state machines, interfaces, persistence, and error behavior.
- [Technology stack](technology-stack.md) — frozen foundations, candidate libraries, and selection gates.
- [SDK and Private AI Node technology stack](../../hybridAi/docs/technology-stack.md) — externally owned mobile SDK and Linux/Windows/macOS node implementation stack.
- [Audio Journal product boundary](product-boundaries.md) — enforced separation from SDK internals and the Private AI Node server/application.
- [UX design](ux-design.md) — screens, interaction rules, and privacy-preserving user flows.
- [Visual design](visual-design.md) — proposed visual language, navigation, components, and screen composition.
- [Interactive UI/UX review](design/audio-journal-ui-prototype.html) — standalone browser prototype preserved in this repository.
- [Design file guide](design/README.md) — file roles, recommended format, and regeneration guidance.
- [Security and privacy](security-and-privacy.md) — assets, threats, controls, and unresolved security choices.
- [Backup and restore](backup-and-restore.md) — portable encrypted archive, recovery flow, and exclusions.
- [UML and behavioral diagrams](uml-diagrams.md) — visual trace of the architecture and lifecycle.
- [Implementation roadmap](implementation-roadmap.md) — milestone order and acceptance gates.
- [Real-inference migration](real-inference-migration.md) — mandatory AJ handoff for SDK-owned transcription and real local/node organization before release work.
- [AJ-RI-2 transcription consumer](ri2-transcription-consumer.md) — frozen
  packaged-SDK/JR1 source, final-pass (live text deferred, `AJ-RI2-DEC-001`),
  model-pack, lock, durability, boundary, and validation design (AJ ADR-022 /
  SDK ADR-027); implementation evidence in
  [`validation/AJ-RI-2.md`](validation/AJ-RI-2.md).
- [AJ-RI-3 local organization consumer](ri3-organization-consumer.md) — frozen
  declarative package, explicit-local flow, provenance/grounding boundary,
  human-labelled corpus, scorer, privacy, and migration design (AJ ADR-023 /
  SDK ADR-028); implementation remains blocked on SDK `GRI-1`.
- The migration's first prototype gate includes separately installed Tailscale
  clients for Android-to-Linux node access (Ubuntu is the first validation
  distribution) over direct and relayed paths. The Private AI Node product
  also targets Windows and macOS, with separate native validation gates;
  Tailscale is not an application or SDK dependency.
- [Cross-agent decision bridge](../../hybridAi/docs/agent-decision-bridge.md) — shared non-interactive decision protocol for Codex/Claude implementation sessions.
- [Agent coordination](AGENT_COORDINATION.md) — temporary shared operational memory.
- [AJ-0 validation](validation/AJ0-progress.md) — current build/test evidence and blockers.
- [`journal.organize@1` contract](journal-organize.md) — the frozen AJ-2 organization contract (ADR-019): input, result, provenance, validation order, events, persistence, and open questions.
- [AJ-1 progress](validation/AJ1-progress.md) — AJ-1 evidence: accepted for the Android-emulator development profile (2026-10-12); physical-device Argon2id, real-microphone, performance, thermal/battery, and iOS gates open.
- [AJ-2 progress](validation/AJ2-progress.md) — AJ-2.0 to AJ-2.2 evidence: the `journal.organize@1` contract, the node companion, the public-SDK integration, and the Organized and Tasks UI; accepted for the Android-first profile (2026-10-12) on the deterministic `aj.rules` baseline; physical-device, iOS, O-4 to O-6, and O-7 chunking deferred.
- [AJ-3 Android](validation/AJ3-android.md) — the secure Private AI Node workflow (S00–S19): accepted for the Android-emulator development profile (2026-10-12); physical-network, physical-device, and iOS gates open.
- [AJ-4 progress](validation/AJ4-progress.md) — AJ-4-E, the Android emulator-validated development profile: scope, journeys, validation matrix, gap freeze, and results. Not canonical AJ-4.
- [AJ-2 organize performance suite](validation/AJ2-organize-performance.md) — historical deterministic-engine performance evidence. It is not real-model performance; RI uses real 30/60/180-second inputs under the new bounded profile.

## Change rule

A product, security, architecture, contract, or scope decision is incomplete
until the affected ADR, requirements, HLD, LLD, UX/security guidance, diagrams,
and roadmap are consistent. Implementation discoveries flow back into the same
documents; the code must not silently diverge from them.

## External source of truth

Hybrid AI SDK behavior is owned by the sibling SDK repository. This app may
document the public contracts it consumes, but it must not redefine SDK internals.
Pin the SDK version or commit in every future validation report.
