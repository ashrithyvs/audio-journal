# Audio Journal Product Boundary

**Status:** Frozen by AJ ADR-021, SDK ADR-026, and the SDK
[product boundary](../../hybridAi/docs/product-boundaries.md).

Audio Journal is an Android/iOS application and external SDK consumer. It is
not part of the Hybrid AI SDK and it is not the Private AI Node server/app.

## Audio Journal owns

- journal recording, playback, encrypted storage, backup, lock, and UX;
- consent and explicit Local/Private Node selection;
- `journal.organize@1` descriptors, schemas, prompt/pipeline instructions,
  provenance constraints, labelled evaluation data, and result validation;
- configuration UX for a user-supplied node endpoint through the public SDK;
  and
- persistence and presentation of validated results.

## Audio Journal does not own

- `whisper.cpp`, `llama.cpp`, ONNX Runtime, Ollama, or another inference/model
  server integration;
- SDK routing, model/profile loading, leases, resource admission, pairing,
  mTLS, discovery, node protocol, event ordering, or cancellation mechanics;
- the native `private-ai-node` executable, operator CLI/control endpoint,
  Boost.Asio/Beast, OpenSSL, Linux/Windows/macOS services, credentials,
  discovery adapters, or native packages; or
- cloud/relay infrastructure, master/sub-agents, node tools, or node storage.

AJ consumes versioned Android/iOS/React Native SDK packages only. It may produce
a bounded, hash-verified capability **data bundle** for installation into the
generic node. The bundle contains no executable AJ code, user journal data,
private evaluation corpus, key, database adapter, or model runtime.

## Enforcement

AJ-RI gates fail if production application artifacts contain direct model
runtimes after migration, historical `node-companion`, node server/framework
code, desktop adapters, or private SDK headers. They also fail if integration
uses a sibling source path instead of a versioned package, or if the node needs
recompilation to understand the AJ bundle.

The historical app-owned Whisper and `node-companion` code may remain only as
clearly labelled migration/history material until their removal stage. They
are excluded from post-AJ-RI-2/post-AJ-RI-4 product builds, runtime selection,
deployment instructions, and acceptance evidence respectively.

AJ ADR-022 does not make the separate RI-2 model pack an AJ-owned runtime or
model. AJ deployment may copy the exact SDK-defined, hash-pinned dependency to
app-private SDK storage. AJ source cannot parse, select, load, invoke, replace,
or download the model outside the packaged SDK public contract.

SDK, node, and AJ versions/releases remain independent. Compatibility is
carried by public SDK, protocol, schema, capability-package, and model-profile
versions.

## Cross-repository diagnosis and SDK handoff

This boundary does not prevent diagnosis. If an AJ functional, accuracy, load,
or performance test indicates that the packaged SDK or Private AI Node may be
responsible, the AJ agent may inspect the **exact pinned** `hybridAi` source,
documents, tests, and commit history read-only. It may reproduce through the
public API, isolate the likely owner, write an evidence-backed root-cause
analysis, and propose a fix and regression tests.

The AJ agent must not edit or commit in `hybridAi`, patch the consumed package,
import private SDK/node code, silently alter an SDK contract, or present a
proposal as an accepted fix. Before classifying an SDK defect it separates AJ
application, test harness, device/OS, network, node, model/profile, and SDK
causes as far as the available evidence permits.

Record each issue in
[`validation/hybrid-ai-sdk-issues.md`](validation/hybrid-ai-sdk-issues.md) and
the decision bridge as `SDK-FINDING-###`, including the AJ and SDK/package
hashes, environment/model profile, expected and observed behavior, minimal
public-API reproducer, isolation evidence, privacy-scrubbed reports, RCA and
confidence, cited source locations, proposed fix, SDK regression tests, and AJ
reruns. If authorized, a separate SDK-owned task implements and validates the
fix and produces a versioned package. AJ then updates pins/hashes and reruns
the affected journey and required baseline before consumer acceptance.
