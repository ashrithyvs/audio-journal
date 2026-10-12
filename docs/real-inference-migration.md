# Audio Journal Real-Inference Migration

**Status:** Frozen Android-first validation handoff for an Android+iOS product
(2026-10-13).
**SDK work package:**
[`hybridAi/docs/real-inference-roadmap.md`](../../hybridAi/docs/real-inference-roadmap.md).
**Controlling AJ decision:** ADR-021.

This document tells a new agent exactly how Audio Journal participates in the
SDK real-inference milestones. It supersedes target-design statements that put
Whisper or organization inference inside the application, while preserving
historical implementation/evidence as historical facts.

## 1. Fixed application boundary

Audio Journal owns:

- microphone permission, native recording, AJR1 encryption, playback, vault,
  database, backup, UI, consent, source-of-truth records, corrections, and
  provenance presentation;
- the declarative `journal.organize@1` contract, schemas, prompt/instructions,
  labelled evaluation corpus, and acceptance rubric; and
- the user's explicit organization target selection: `local` or `node`.

The packaged Hybrid AI SDK owns:

- whisper.cpp and every other transcription-runtime integration;
- llama.cpp/ONNX and every other model-runtime integration;
- local model/profile loading, validation, leases, unload, cancellation, and
  inference;
- authenticated Private AI Node relay and returned stream/result; and
- provider/model errors and privacy-safe diagnostics.

The app must not import or invoke a model runtime, local model server, or node
model API. It uses public capability APIs only.

## 2. Target flows

Voice capture and transcription:

```text
microphone -> AJ encrypted AJR1 recording
           -> SDK audio.transcribe@1 (target: local)
           -> timestamped transcript events
           -> AJ validation and encrypted persistence
```

Organization:

```text
AJ written text or finalized transcript + provenance
           -> SDK journal.organize@1 (target selected explicitly)
              -> local: SDK local llama.cpp provider
              -> node: SDK node client -> generic Private AI Node model provider
           -> SDK validated result/events
           -> AJ validation, immutable derivation, Organized/Tasks UI
```

Raw recording bytes, paths, recording keys, vault material, and unrelated
entries are never placed in a node request. In `node` organization mode,
transcription still runs locally through the SDK.

## 3. Migration stages

### AJ-RI-0 — Documentation and harness truth

Runs with SDK RI-0. Supersede ADR-016 and the engine/deployment parts of
ADR-018. Keep ADR-019/020 domain contract, provenance, history, and task rules.
Relabel `aj.rules` evidence as contract/UI/transport evidence.

Exit: no canonical target-design document assigns a model runtime to AJ, and no
real-model acceptance claim cites `aj.rules`.

### AJ-RI-2 — Transcription consumer migration

Runs against an RI-2 packaged SDK.

- Replace `TranscriptionService`'s app-owned engine implementation with a public
  SDK `audio.transcribe@1` adapter.
- Preserve encrypted recording access, live/final UX, cancellation, correction,
  reconciliation, and transcript revisions.
- Remove app build/runtime dependencies on whisper.cpp and its model artifact.

Exit: real 30/60/180-second recordings transcribe through the packaged SDK;
timestamp, WER, latency, memory, cancel, lock, and failure tests pass; recording
durability never depends on AI success.

### AJ-RI-3 — Local organization consumer

Runs against an RI-3 packaged SDK.

- Load the AJ-owned declarative capability package through supported SDK
  configuration.
- Add explicit Local organization mode.
- Keep consent, result validation, provenance, history, task state, and source
  navigation unchanged.
- Remove `aj.rules` from production execution while retaining it as a contract
  oracle in isolated tests.

Exit: the SDK's real local model meets the RI-3 accuracy gate and completes
written plus 30/60/180-second voice-transcript journeys.

### AJ-RI-4 — Generic node consumer

Runs against RI-4 generic Private AI Node packages.

- Retire `node-companion` as an independent protocol/security/model host.
- Keep AJ capability schemas, prompts, vectors, and evaluation assets here;
  deploy them as data/configuration to the generic node.
- Preserve pairing and explicit consent UX through public SDK APIs.
- Accept an explicit Private AI Node endpoint as a MagicDNS name or IP plus
  port; do not add a Tailscale library or control-plane integration to AJ.

Exit: a real desktop model result travels generic node -> SDK -> AJ, satisfies
the contract/accuracy gates, and survives cancel, node restart, identity and
network recovery tests. Audio never leaves the device.

### AJ-RI-5 — Dual-mode application gate

- The organization screen offers Local and Private Node.
- There is no automatic fallback or hidden target/model change.
- Diagnostics show target, profile, timing, and typed errors without content.
- Run the same labelled cases through both modes and retain separate results.

Exit: every RI-5 gate in the SDK roadmap passes against packaged artifacts.

### AJ-RI-6 — Installable prototype

Produce the debug-signed Android APK, tester guide, accuracy/performance
reports, known issues, and generic node startup instructions. Emulator and node
runs obey the shared-machine rules in the SDK roadmap.

The first tester guide covers the stock Tailscale clients on Android and the
Linux/Ubuntu node profile, the configured MagicDNS/IP endpoint, tailnet access
control, and how retained evidence distinguishes direct from relayed
connectivity. Windows and macOS node guides/evidence accompany their native
SDK gates. AJ uses the same public API and pairing/mTLS identity on every host.

One physical Android phone is required only for the direct and relayed
Tailscale reachability journeys. All physical-device performance, thermal,
battery, low-memory, compatibility, and production-support certification stays
deferred. The API 35 emulator remains the functional/performance development
profile.

Exit: `GRI-6-A` passes, including the bounded phone connectivity proof. This
authorizes broader exploratory phone testing but is not canonical AJ-4,
physical-device certification, production readiness, iOS acceptance, or
release approval.

### AJ-RI-I — Cumulative iOS real-inference gate

Android-first describes execution order, not an Android-only application.
During AJ-RI-2–AJ-RI-6, React Native iOS, native adapters, public SDK usage,
domain behavior, consent, validation, persistence, and error handling stay
aligned wherever mechanically possible. Paths not compiled and run are marked
**unverified**, never passed by inference from Android.

After `GRI-6-A`, the SDK's cumulative `GRI-6-I` gate runs Audio Journal through
packaged iOS artifacts and covers real SDK-owned local transcription, real
`journal.organize@1` in explicit Local and Private Node modes, pairing/mTLS,
configured LAN/Tailscale endpoint use, cancellation/deadlines, lifecycle and
network recovery, lock/persistence, provenance, Organized/Tasks, source
navigation, privacy, accuracy, bounded load, and performance. Simulator runs
may prove integration, but supported physical iPhone evidence is required for
microphone, model performance, memory/thermal behavior, secure storage, and
real-network claims. Tailscale remains an independently installed stock iOS
client, not an AJ or SDK dependency.

`GRI-6-A` authorizes the Android prototype only. Cross-platform mobile support
and v0.1 release require `GRI-6-I`, SDK `G0-I`–`G5-I`, affected Android/host
regressions, and canonical release acceptance.

## 4. Audio and performance limits

The prototype accuracy/performance matrix uses real 30-second, 60-second, and
180-second voice recordings. Use natural speech containing representative
tasks, people, dates, ideas, and Work/Personal content. Include negative cases
with no actionable task.

- Do not add 5-, 10-, 30-, or 60-minute audio to the prototype gate.
- Use at most three warm repetitions per case.
- Do not run extended soaks; the maximum prototype stability block is 20
  minutes.
- Use the shared exclusive-run lock and never overlap builds, unrelated model
  runs, or multiple emulators.
- Do not commit private recordings or transcripts. Store corpus identifiers,
  hashes, consent/source classification, derived metrics, and redacted examples.

Long-journal chunking and quality are future development tasks.

Node-initiated requests for more journal context or device capabilities are
also future work. AJ-RI supplies the complete user-selected request once. A
future reverse exchange must be separately versioned and consented, keep AJ as
the data authority, enforce strict scope/size/round/provenance limits, and
remain deniable. It cannot grant the node general journal, file, audio, key,
microphone, or action access. Its purpose is better grounding for
resource-bounded private-node models, not an assumption of frontier-model
capability.

## 5. Acceptance truth

Existing AJ-1, AJ-2, AJ-3, and AJ-4-P evidence remains valid for encrypted
storage, recording/playback, UX, schemas, provenance, pairing, transport,
cancellation, and emulator responsiveness as stated in its reports.

It does not establish the new target design because:

- AJ-1 directly owns Whisper today;
- AJ-2/AJ-4-P organization uses deterministic `aj.rules`; and
- the standalone companion is not the generic SDK-owned model host.

No historical result is deleted or rewritten. New RI reports cite it only for
the behavior it actually measured.

## 6. Resuming in a new agent

Before editing, read `AGENTS.md`, `docs/AGENT_COORDINATION.md`, ADR-021, this
document, the SDK ADR-024/roadmap, and the affected HLD/LLD. Then report:

- both repositories' branches, heads, and worktree status;
- last green RI gate and package/model hashes;
- active file claims and exclusive-run lock;
- exact AJ layer and SDK public surface being consumed;
- tests required for the current AJ-RI stage; and
- physical-device/iOS/long-audio items still deferred, with iOS explicitly
  remaining a supported target governed by `GRI-6-I`.

Do not infer acceptance from chat history or an APK alone.

Implementation questions use the SDK's
[cross-agent decision bridge](../../hybridAi/docs/agent-decision-bridge.md).
It prevents blocking Claude UI prompts only after each session is instructed to
use it and a Codex monitor is active.
