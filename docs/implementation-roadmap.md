# Implementation Roadmap

**Status:** Target staged plan. Development has not started.

## 1. Delivery rules

1. Work in milestone order unless a documented dependency permits preparation.
2. Resolve Open ADRs before implementing the affected security/data/audio contract.
3. Every milestone includes unit, smoke, integration, recovery, privacy, and
   performance evidence appropriate to its surface.
4. Keep docs, schemas, tests, and implementation in one logical change.
5. Consume a pinned packaged Hybrid AI version; never import SDK private source.
6. Android-first progress is permitted in alignment with the SDK roadmap, but
   iOS catch-up is mandatory before v0.1 cross-platform/release claims.
7. Preserve unknown changes and record agent handoff state after meaningful work.

## 2. AJ-0 — Repository and application scaffold

Prerequisite: design review plus accepted security/audio decisions needed by the scaffold.

- Create React Native TypeScript app with New Architecture and native builds.
- Add navigation, feature boundaries, testing infrastructure, and public SDK package.
- Implement local lock shell, PIN setup/fallback, optional biometric prompt,
  content-obscuring background behavior, and secure-store abstraction.
- Add fake/in-memory capability adapters; no journal persistence yet.

Exit: clean install launches locked, creates/unlocks with PIN, exercises biometric
fallback on supported devices, initializes the packaged SDK, and contains no
account flow or SDK-private import.

## 3. AJ-1 — Durable local journal capture

- Implement approved encrypted SQLite/file foundations and migrations.
- Implement voice/written entry domain, recording service, playback, timeline,
  entry detail, startup reconciliation, and storage-pressure behavior.
- Implement the accepted portable encrypted backup format, create/save flow,
  verified empty-vault restore, and cross-platform round-trip fixtures.
- Integrate the approved live transcription capability with independent cancellation.
- Add transcript correction and source timestamps.

Exit: voice/written capture, pause/resume, restart, playback, transcript, recovery,
offline use, verified backup, app-data-clear restore, and byte-identical recording
round-trip pass without a node; STT failure never loses audio.

## 4. AJ-2 — Application-owned organization

- Freeze and version `journal.organize@1` request/result/event JSON schemas.
- Implement explicit selection/consent, SDK streaming adapter, terminal validation,
  derivation revisions, tasks, and source-reference navigation.
- Cover malformed output, provenance escape, timeout, cancellation, retry, and
  idempotency behavior.

Exit: organization uses only public SDK APIs; valid results remain traceable and
all failure paths leave source entries unchanged.

## 5. AJ-3 — Secure Private AI Node workflow

- Add SDK-provided discovery, QR pairing, status, reconnect, forget/re-pair UX.
- Validate denied local-network permission, expired QR, spoofed candidate,
  wrong identity, revoked device, network transitions, and node unavailability.
- Verify that minimum selected transcript content—not audio by default—is sent.

Exit: a tester can pair, organize, reconnect, forget the node, and continue using
the local journal without developer tools or content loss.

## 6. AJ-4 — Hardening and release acceptance

- Exercise `local`, `node`, and `auto` modes and privacy-safe developer diagnostics.
- Test long recordings, repeated sessions, lifecycle transitions, interruptions,
  cancellation races, low storage, memory pressure, key invalidation, and migration.
- Run dependency/privacy review and plaintext-at-rest/log/backup inspection.
- Produce tester guide, fixture media, supported-device matrix, and baselines.

Exit: Android and iOS journeys pass on the frozen matrix, with results attached
to the Hybrid AI SDK release evidence where required.

## 7. Required validation dimensions

- **Unit:** domain invariants, reducers/view models, state machines, validators,
  repositories, key policy, and error mapping with fakes.
- **Smoke:** clean build/install, lock/unlock, create/open entry, restart, SDK version.
- **Integration:** real DB/files, native audio, packaged SDK, bindings, node transport.
- **Recovery:** process death and injected failure at every recording/migration/delete transition.
- **Security/privacy:** credential/content leakage, key invalidation, malformed AI,
  pairing adversaries, permissions, backups, snapshots, and logs.
- **Performance:** capture-start latency, first transcript text, frame backlog, DB
  write cost, long-session memory, playback, organization first event/total time,
  battery, storage growth, and thermal behavior.

## 8. Pre-implementation approval checklist

- [ ] Database and recording encryption/key ADR accepted.
- [ ] PIN KDF, retry/backoff, biometric invalidation, and reset semantics accepted.
- [ ] Recording format/library, interruptions, duration, and storage limits accepted.
- [ ] Portable backup AEAD/KDF/container/chunking and restore activation ADR accepted.
- [ ] Transcription capability and frame contract accepted against packaged SDK.
- [ ] `journal.organize@1` schemas and provenance rules accepted before AJ-2.
- [ ] Android/iOS minimum versions reconciled with the SDK's supported matrix.
