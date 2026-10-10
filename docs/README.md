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

## Canonical documents

- [Architecture decisions](architecture-decisions.md) — frozen decisions and open ADRs.
- [Scope and requirements](scope-and-requirements.md) — v0.1 boundaries and traceable requirements.
- [Business use cases](business-use-cases.md) — actors, user value, and business rules.
- [High-level design](high-level-design.md) — system context, containers, and major flows.
- [Low-level design](low-level-design.md) — domain model, state machines, interfaces, persistence, and error behavior.
- [Technology stack](technology-stack.md) — frozen foundations, candidate libraries, and selection gates.
- [UX design](ux-design.md) — screens, interaction rules, and privacy-preserving user flows.
- [Visual design](visual-design.md) — proposed visual language, navigation, components, and screen composition.
- [Interactive UI/UX review](design/audio-journal-ui-prototype.html) — standalone browser prototype preserved in this repository.
- [Design file guide](design/README.md) — file roles, recommended format, and regeneration guidance.
- [Security and privacy](security-and-privacy.md) — assets, threats, controls, and unresolved security choices.
- [Backup and restore](backup-and-restore.md) — portable encrypted archive, recovery flow, and exclusions.
- [UML and behavioral diagrams](uml-diagrams.md) — visual trace of the architecture and lifecycle.
- [Implementation roadmap](implementation-roadmap.md) — milestone order and acceptance gates.
- [Agent coordination](AGENT_COORDINATION.md) — temporary shared operational memory.
- [AJ-0 validation](validation/AJ0-progress.md) — current build/test evidence and blockers.
- [AJ-1 progress](validation/AJ1-progress.md) — AJ-1 evidence: the Android implementation is provisionally complete on emulator evidence and merged into `main`; not accepted (physical-device and iOS gates deferred).

## Change rule

A product, security, architecture, contract, or scope decision is incomplete
until the affected ADR, requirements, HLD, LLD, UX/security guidance, diagrams,
and roadmap are consistent. Implementation discoveries flow back into the same
documents; the code must not silently diverge from them.

## External source of truth

Hybrid AI SDK behavior is owned by the sibling SDK repository. This app may
document the public contracts it consumes, but it must not redefine SDK internals.
Pin the SDK version or commit in every future validation report.
