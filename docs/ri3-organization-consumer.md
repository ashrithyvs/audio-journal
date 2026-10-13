# AJ-RI-3 Local Organization Consumer Architecture

**Status:** Frozen design (2026-10-13). Implementation remains blocked until
SDK `GRI-1` acceptance and then SDK RI-3 candidate packages are available.
**Controlling decisions:** AJ ADR-019, ADR-020, ADR-021, ADR-023; SDK ADR-024,
ADR-026, ADR-028.

## 1. Purpose and ownership

AJ-RI-3 makes the existing `journal.organize@1` contract executable through
the packaged Hybrid AI SDK's explicit `local` target using a real SDK-owned
llama.cpp model. It does not add an AI runtime to this repository.

Audio Journal owns the contract schemas, instructions, consent, selected input,
labelled evaluation corpus, semantic/provenance validation, history/task rules,
encrypted persistence, and UX. The SDK owns model/profile verification,
llama.cpp integration, prompt mechanics, tokenizer/chat-template, grammar,
resource admission, cancellation/deadlines, structural output validation, and
typed execution errors. No AJ source is compiled into the SDK or node.

`aj.rules` remains a deterministic contract/vector oracle. It is excluded from
the RI product execution graph and cannot satisfy functional, accuracy, load,
or performance acceptance.

## 2. Declarative capability artifact

AJ publishes a bounded data-only `CapabilityPackage` for
`journal.organize@1`. It contains:

- the existing input/output Draft 7 schemas without changing the public domain
  result contract;
- versioned organization instructions and prompt revision;
- exact local and later node profile approvals;
- existing 61,108-byte input and 61,387-byte output limits;
- provenance-required and streaming metadata; and
- the frozen evaluation identity/revision.

The package contains no app executable, model/runtime, user data, corpus,
database/path/key access, or private prompt content. Its exact bytes and
SHA-256 are release inputs. Android passes package bytes through the packaged
SDK creation surface; React Native transports them as base64 plus the digest.
The SDK installs the complete set atomically when the runtime is created. AJ
does not mutate packages or models in a running runtime.

The approved local profile is selected by the SDK GRI-3 bake-off, not by AJ
metadata or historical `aj.rules` results. AJ pins the accepted SDK package,
capability digest, profile ID/version, provider revision, model artifact digest,
tokenizer/template revision, and evaluation revision in its candidate build.

## 3. Execution flow

1. The user selects entries and explicitly chooses Local processing.
2. AJ presents the existing consent summary before sending finalized text and
   source metadata to the packaged SDK.
3. AJ builds the existing canonical input and keeps the current request-key and
   input-digest rules.
4. AJ calls only the public SDK `journal.organize@1` API with target `local` and
   the absolute deadline. No node request or fallback is allowed.
5. Progress may update non-content UI. Unvalidated token text or partial JSON
   is not displayed or persisted.
6. On SDK completion, AJ runs `resultViolation()` and the accepted history,
   staleness, due-date, source, and task-state rules.
7. Only a result passing every domain check is encrypted and stored. Failure,
   cancellation, lock, deadline, context overflow, or invalid model output
   stores no derived result and leaves source entries unchanged.

The current controller's node-only target and node-result assertion are
migration work for RI-5, not a reason to bypass the SDK in RI-3. RI-3 first
proves the provider/package and GRI-3 evaluation; RI-5 adds the user target
selector and cumulative local/node product journeys.

## 4. Grounding and provenance

The model must return the accepted `SourceRef`: `entryId`, `unitId`,
`unitSha256`, `charStart`, `charEnd`, and voice audio bounds where applicable.
No new free-form quote contract is introduced.

The existing deterministic validator continues to reject unknown sources,
wrong digests, out-of-range or misordered spans, missing audio bounds,
unreproducible dates, wrong requested kinds, invalid completeness metadata,
duplicates, malformed JSON, and over-limit results. These checks prove
reference integrity and bounds, not semantic truth.

Semantic support is measured separately on the frozen human-labelled corpus:
tasks, people, ideas, dates, Work/Personal sections, negatives, source overlap,
and summary factuality. A grammatically valid or in-bounds citation that does
not support the claim is a model accuracy failure. Structurally rejected,
cancelled, timed-out, or missing results remain in the gate denominator.

## 5. Input, context, and long entries

AJ never shortens selected source content to make a model fit. The SDK
tokenizes the full rendered request before inference and returns a typed
failure when prompt plus maximum output exceeds the profile context. AJ shows a
clear no-result state and stores nothing.

Long-entry chunking/merge remains deferred. It would require a new completeness
and provenance aggregation contract and cannot be hidden behind the current
package. Prototype evidence stays at real 30-, 60-, and 180-second transcripts
and representative written cases.

## 6. GRI-3 evaluation contribution

AJ supplies a separate development set and a sealed held-out corpus of at least
100 cases: 40 written and 20 each from real 30-, 60-, and 180-second
transcripts. It balances Work/Personal, tasks, people, ideas, dates, sections,
ambiguous statements, negative/no-task cases, and exact source labels.

The corpus manifest records case/recording/transcript hashes, licence or
consent class, durations, locale, label/rubric/scorer revisions, and reviewer
access. Private journal content is not committed. Two independent scorers must
agree. The SDK ADR-028 weights are tasks 0.35, sections 0.20, people 0.15,
ideas 0.15, and dates 0.15; weighted F1 must be at least 0.80. Blinded atomic-
claim summary factuality must be at least 90%.

Accepted-output schema validity and citation bounds must both be 100%, with
zero invented citations and zero silent truncation. Real-model latency, token
rate, peak RSS, cancellation, and failures are recorded separately from
fixture/contract evidence.

## 7. Platform, privacy, and boundaries

The Android API 35 emulator is the first executable profile. The final SDK
native core, AAR/RN consumer, x86_64 execution, and arm64-v8a build/content are
required for GRI-3. Physical Android performance remains deferred to the
physical-device gate. iOS source parity is maintained but execution is
**UNVERIFIED** until macOS/Xcode `GRI-6-I`.

Logs and reports contain only content-free IDs/hashes, counts, timings, token
counts, memory, environment, and terminal codes. They contain no entry text,
transcript, prompt, model output, PIN, key, or pairing payload. A planted-
secret scan verifies the evidence collector.

Repository checks fail if AJ production code imports llama.cpp/ggml/ONNX or
another model server, if a model is packaged in the app/SDK binary, if AJ code
enters the SDK/node products, or if the historical companion/rules engine is a
production provider.

## 8. Ordered AJ work and exit

1. Wait for formal SDK `GRI-1` acceptance; no implementation starts sooner.
2. Publish the exact data-only package and corpus/scorer assets without adding
   a runtime.
3. Consume an exact RI-3 SDK/model-pack candidate in an isolated AJ branch.
4. Run package construction, domain-validation, privacy, and boundary tests;
   support the sealed GRI-3 bake-off without tuning on held-out results.
5. After GRI-3 acceptance, RI-5 adds the Local/Private Node user selector and
   runs the cumulative product journeys. AJ `main` does not claim real local
   organization before those accepted packages and consumer tests exist.

This freeze selects no model and claims no accuracy, performance, or GRI-3
result.
