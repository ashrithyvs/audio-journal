# Security and Privacy Design

**Status:** Frozen security properties with pre-implementation mechanisms Open.

## 1. Assets

- Original audio and written entries.
- Transcript segments and user corrections.
- Derived artifacts, tasks, and provenance.
- Database/file encryption keys and PIN verifier material.
- Portable backup archives and backup password/recovery-key material.
- App settings, node pairing state exposed through the SDK, and diagnostics.

## 2. Threat actors

- A casual person holding an unlocked or locked device.
- An attacker with access to app backups or extracted application files.
- A malicious/compromised app attempting screenshot, clipboard, log, or file access.
- A hostile LAN device impersonating a Private AI Node.
- A malformed or compromised AI capability returning adversarial output/references.
- Accidental data loss caused by process death, interruption, migration, or low storage.

Compromise of an already-unlocked operating system/rooted device is only partly
mitigable, but the design must not make extraction easier through plaintext
credentials, content-rich logs, or unprotected exports.

## 3. Security properties

1. App content is hidden until local authentication succeeds.
2. PIN/passcode is never stored in plaintext.
3. Biometrics remain inside platform APIs; no raw biometric data reaches the app.
4. Protected key material uses platform secure storage and fails closed.
5. Journal content never enters public cloud/telemetry by default.
6. Private-node trust and transport are delegated to the SDK's accepted pairing model.
7. AI output is untrusted input and is schema/bounds/provenance validated.
8. Source material remains recoverable across AI failure and common app crashes.

## 4. Data states and controls

| State | Required control |
|---|---|
| In capture memory | Bounded buffers; no content logging; promptly release frames. |
| Recording file | App-private path; at-rest encryption mechanism to be approved. |
| SQLite data | App-private database; encryption/key design to be approved. |
| Secure credentials | Keychain/Keystore-backed non-exportable or wrapped material. |
| SDK request | Minimum selected content; paired authenticated private channel. |
| UI/background | Protected navigation gate and obscured app-switcher snapshot. |
| Diagnostics | Metadata allowlist; no journal content or secrets. |
| Backup archive | Authenticated encryption under a strong portable secret; user-chosen destination. |

## 5. App-lock design constraints

- Local PIN setup is mandatory; biometric enablement is optional.
- PIN verification and data-key unlock must be designed together so the screen
  lock is not the only protection against extracted storage.
- Use a memory-hard KDF where platform/runtime support and measured mobile cost
  permit; exact algorithm/parameters require an ADR and device benchmarks.
- Apply bounded attempt backoff without creating a permanent denial of service.
- Biometric-protected key access must define behavior after enrollment changes.
- Changing PIN must rewrap keys atomically without rewriting all data where possible.
- A missing key or forgotten PIN has no server recovery. Reset semantics must
  state whether encrypted local data becomes permanently inaccessible/deleted.

## 6. Private AI Node privacy

- Node use is optional and explicit for organized mode.
- Send finalized transcript text and selected provenance references by default,
  not original audio.
- Do not expose local absolute paths, encryption keys, or unrelated entries.
- Treat SDK discovery as untrusted until the SDK reports paired/authenticated state.
- Forgetting the node removes node access but does not delete local content.
- Never add public-cloud fallback for convenience.

## 7. AI output validation

Treat node output as untrusted structured data:

- validate JSON schema, sizes, counts, enum values, and string lengths;
- reject source references outside the selected input scope;
- render text as data, never executable markup/commands;
- persist only after one terminal valid result;
- do not execute tasks, links, tools, or instructions returned in content;
- record only sanitized error codes if validation fails.

## 8. Deletion and recovery

Portable backup behavior is frozen for v0.1; its exact cryptographic/container
mechanism remains open. Deletion, retention, and any separate human-readable
data export are not yet frozen. Before implementation, the security ADR must
define transactional deletion across DB/files/keys, crash recovery, and whether
deleted encrypted bytes can remain in SQLite/WAL/filesystem blocks. UI must not
promise cryptographic erasure without evidence from the chosen storage stack.

Portable backup is the v0.1 recovery mechanism for cleared application data. It
must not reuse the short app PIN as its sole offline secret, include device-bound
keys, or leave plaintext staging data. Archive headers must reveal only the
minimum information needed to identify/derive/decrypt the format; all journal
metadata, filenames, counts, and checksums belong inside authenticated encryption
unless the approved format documents a necessary bounded exception.

## 9. Required security validation

- PIN/biometric fallback, lockout, enrollment change, app restart, and key loss.
- App-switcher/screenshot/notification leakage review.
- Plaintext search over files, DB/WAL, backups, logs, crash reports, and temp files.
- Backup password/recovery-key handling, archive tamper/truncation, malicious
  paths/counts/sizes, wrong secret, rollback/version, and cross-platform restore.
- Recording interruption and low-storage recovery without orphan leakage.
- Malformed/oversized AI results and provenance escape attempts.
- Wrong/spoofed/revoked node scenarios through the Hybrid AI acceptance matrix.
- Dependency and native permission review on both platforms.

## 10. Open security ADR

Implementation is blocked until a decision freezes:

- database encryption technology and migrations;
- streaming recording encryption/container and playback strategy;
- master/data key hierarchy and secure-store representation;
- PIN KDF algorithm/parameters and attempt policy;
- biometric access-control flags and invalidation behavior;
- destructive reset flow and any separate human-readable export format;
- portable archive AEAD/KDF/container/chunking, recovery-key encoding, metadata
  exposure, and cross-platform version fixtures.

## 11. AJ-0 implementation boundary

The AJ-0 scaffold implements the lock state machine, fail-closed error paths,
PIN fallback UI, lifecycle relock, background privacy curtain, and Android
`FLAG_SECURE`. It does not implement persistent credentials or production
biometrics. The included volatile verifier is process-local, non-cryptographic,
clearly labelled, and must be replaced—not promoted—after this ADR is resolved.
