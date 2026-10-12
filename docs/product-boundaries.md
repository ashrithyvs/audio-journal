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

SDK, node, and AJ versions/releases remain independent. Compatibility is
carried by public SDK, protocol, schema, capability-package, and model-profile
versions.
