# AJ-4-A Prerequisite Decisions

**Status:** Open. These are proposals awaiting owner decisions, not accepted
ADRs. Nothing here authorizes implementation.

**Date:** 2026-10-09. **Context:** the owner asked for Android-first AJ-4
acceptance (AJ-4-A) after AJ-3. AJ-4-A's end-to-end journey requires
AJ-1/AJ-2 functionality: recording, playback, local transcription,
`journal.organize@1`, encrypted persistence, biometrics, and backup. None of
that exists in this repository. Each item below is blocked by an Open ADR, or
by an absent SDK or node capability. Under the repository rules (ADR-012,
roadmap §1), the affected work may not be implemented by silently choosing a
design or by mocking the stage.

## Verified facts (2026-10-09)

- The packaged SDK `0.1.0-m5` (`e0fc3c5`) ships two local capability manifests:
  - `text.complete`: a 260K-parameter `stories260K.gguf`, 8 output tokens;
  - `vector.embed`.

  It ships no transcription or speech capability, in the AAR assets, the
  schemas, or the public TypeScript API.
- The reference Private AI Node advertises exactly one capability,
  `document.analyze@1`, from a hard-coded list in the SDK repository
  (`reference-node/src/jobs.mjs`). AJ work may not modify that repository.
- The AJ app has no database, file store, recorder, player, transcript model,
  credential storage, biometric adapter, or backup service. The AJ-0 lock
  verifier is volatile by design (ADR-014).

## Blocking decisions

| # | Blocks AJ-4-A stages | Open item | Options | Recommendation |
|---|---|---|---|---|
| B1 | 11, 12, 19, and the transcription parts of 13/18 | **Local transcription capability** (ADR-009) | (a) The SDK adds a generic local `audio.transcribe@1` (ONNX/whisper class) per the SDK roadmap's AJ-1 text. (b) The app uses platform speech recognition behind its own port, which departs from ADR-009/AJ-1, and Android `SpeechRecognizer` may use a network service unless forced offline. (c) The node transcribes, which sends raw audio and conflicts with ADR-011's default. | (a). The SDK owner must schedule it; it is an SDK change. |
| B2 | 15–17, 20, 23–26 | **`journal.organize@1` contract and a node that serves it** (Open decision 4) | (a) The SDK owner gives the reference node an application-capability extension point, or a second fixture capability, with the AJ team owning the schema. (b) The AJ repo ships its own node-side worker against the public node protocol, which needs the protocol published as a consumable contract. (c) AJ-4-A uses `document.analyze@1` as a stand-in, which is not the frozen contract and cannot carry provenance. | (a), with the AJ schema frozen first. (c) is acceptable only as clearly labelled interim evidence, never as stage 15. |
| B3 | 7, 13, 22, 25, 27, 30 | **Database and recording encryption, keys, and migrations** (ADR-007) | SQLCipher-backed SQLite with a Keystore-wrapped data key; or platform-encrypted files plus an unencrypted index (rejected by ADR-007's spirit). | SQLCipher plus Keystore-wrapped keys, after a compatibility spike on RN 0.87 New Architecture. |
| B4 | 3–6, 30 | **PIN KDF, attempt policy, biometric binding, and reset** (security ADR) | Argon2id or scrypt verifier; biometric-bound Keystore key with invalidation on enrollment change; a destructive-reset policy. | Argon2id plus a `setInvalidatedByBiometricEnrollment` key, decided with B3. |
| B5 | 8–10, hardening | **Recording library and format, interruptions, limits** (ADR-008) | Native module (AudioRecord + MediaCodec AAC/Opus), or a maintained RN recorder library. | A native module, for durable chunked writes and frame access for B1. |
| B6 | 28–29 | **Portable backup cryptography and container** (ADR-013) | Age-style AEAD stream with Argon2id; or a custom chunked AES-GCM container. | Decide after B3, so the archive and the vault share primitives. |

## What can proceed without these decisions

- AJ-3 (secure node workflow) is complete; see the
  [AJ-3 report](validation/AJ3-android.md).
- Routing diagnostics for `local`, `node`, and `auto` using the existing
  product-neutral capabilities: `document.analyze@1` on the node, and
  `text.complete` locally if the app provisions the packaged model directory.
  This is SDK-routing evidence, not journal evidence.
- Hardening of the AJ-3 surface: node interruption, policy denial, cancellation
  races, and the R8 release on API 28/26.

## Requested owner decisions

1. Approve B1(a) and B2(a) as SDK-side work, or choose an alternative.
2. Approve the security/persistence direction (B3–B5) so that AJ-1 can start
   in milestone order.
3. Confirm that AJ-4-A remains blocked until AJ-1 and AJ-2 pass, rather than
   accepting stage substitutions.
