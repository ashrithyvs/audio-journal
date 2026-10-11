# Audio Journal node companion

A separately deployed Private AI Node that serves Audio Journal's
`journal.organize@1` capability (ADR-018, ADR-019; contract in
`../docs/journal-organize.md`). The phone reaches it only through the Hybrid
AI SDK's public API; the companion is never bundled into the app, is not
part of the Hybrid AI SDK or its reference node, and imports no SDK source.
It is built from the SDK's **published** node protocol (SDK ADR-021, ADR-022,
LLD §8–10), its node and pairing schemas, and its pairing vectors.

## Run

Node.js 22.11 or later.

```sh
npm ci                      # installs the pinned dependencies (below)
node bin/aj-companion.mjs serve --port 38443 [--endpoint 192.168.1.20:38443]
node bin/aj-companion.mjs pair      # in a second terminal: shows the pairing code
```

`serve` keeps the node identity and pairing table in
`~/.audio-journal-companion` (`--state-dir`): `node-key.pem`,
`pairings.json`, `node.json`, and `admin.json` are mode 0600. `pair` prints
the `hybrid-ai-pair:` code to enter in Audio Journal (Settings → Private AI
Node), then shows the device's name and six-digit code and asks the operator
to confirm that the phone shows the same code. `pairings` lists devices;
`revoke <pairingId>` removes one.

## What it serves

- `journal.organize` `1.0.0`: streaming, `maximumInputBytes` 61,108, with the
  pinned schemas from `../schemas/journal/v1` (copied into `contract/`;
  `npm run check-contract` fails if a copy drifts).
- The deterministic, explainable `aj.rules` engine (`src/engine.mjs`):
  sentence segmentation, fixed phrase rules, and small lexicons. Every item
  names its rule and cites exact source ranges. Its outputs are pinned in
  `test/golden/engine.json` (`node scripts/engine-golden.mjs --check`).

## Protocol behaviour

| Area | Behaviour |
|---|---|
| TLS | TLS 1.3; TLS 1.2 only with ECDHE-ECDSA AES-GCM or ChaCha20-Poly1305 **and** Extended Master Secret (read from the session's `SSL_SESS_FLAG_EXTMS`, as ADR-022 publishes), for Android API 26–28. Anything else is refused. No session resumption. Client certificates are requested, not CA verified; every protected request is authorized by the client key's pin against the pairing table. |
| Pairing | ADR-022 ceremony: one active QR session (≤ 300 s, single use), HKDF-SHA-256 key schedule, HMAC transcripts T1–T5, six-digit code, operator approval, at most 64 pairings, `DELETE /v1/pairing/self`, `GET /v1/pairing/node-key`. Unauthenticated pairing calls are rate limited (20 per minute per address). |
| Jobs | Idempotency scoped to `(pairing, idempotencyKey)` over the canonical `{capability, deadlineMs, input, stream}`; replay returns the same job, a different body `IDEMPOTENCY_CONFLICT`; at most 4,096 records, never evicted. At most 32 retained jobs for 15 minutes (the oldest finished job makes room; 32 running jobs refuse a new one with `NODE_UNAVAILABLE`). Deadline 1–120,000 ms, armed once at acceptance. Idempotent cancel. Other pairings' jobs are `JOB_NOT_RETAINED`. |
| Events | Sequences from 1 without gaps, at most 64, exactly one terminal; every event message at most 61,440 bytes (a larger result fails the job); unmasked, unfragmented RFC 6455 text frames; `afterSequence` replay. |
| Request key | A completed result is kept for `(pairing, requestKey)` within retention and replayed for the same input digest; the same key with another input fails (contract §9). |

**Interoperability choices.** The SDK's published documents do not fix the
HTTP status of job creation or body framing. The companion uses standard
HTTP/1.1: `201` for a new job and `200` for an idempotent replay, an explicit
`Content-Length` on every response and never chunked encoding, and RFC 6455
framing. These are proven end to end against the packaged SDK on the
emulator (`docs/validation/AJ2-progress.md`), not assumed from SDK source.

## Privacy

Job inputs and results live in memory only and disappear after retention,
cancellation, revocation, or exit. The companion logs only codes, counts,
durations, and TLS handshake facts (protocol, suite, EMS), never journal
text, names, or IDs from requests. Nothing is sent anywhere else.

## Dependencies and threat boundary

Installed from `package-lock.json` (SHA-256
`de0e935ee84c28017050b09830db595482ba762f9d8ebab84bea7665d7d33f78`), which pins
every package to an exact version with its npm `sha512` integrity hash;
`npm ci` refuses a mismatch.

| Package | Version | Licence | Use |
|---|---|---|---|
| `@peculiar/x509` | 2.1.0 | MIT | Creates the node's self-signed P-256 certificate once, over Node's WebCrypto |
| `asn1js` | 3.0.10 | BSD-3-Clause | Reads the `flags` field of the negotiated TLS session (EMS) |
| `reflect-metadata` | 0.2.2 | Apache-2.0 | Polyfill required by `@peculiar/x509`'s dependency injection |
| `@peculiar/asn1-*` (12 packages) | 2.10.0 | MIT | Transitive (X.509 and ASN.1 structures) |
| `@peculiar/utils` | 2.0.3 | MIT | Transitive |
| `pvtsutils` / `pvutils` | 1.3.6 / 1.2.0 | MIT | Transitive |
| `tsyringe` | 4.10.0 | MIT | Transitive |
| `tslib` | 2.8.1, 1.14.1 | 0BSD | Transitive |

- **No hand-written DER or cryptographic primitives.** Certificates come from
  `@peculiar/x509`; HKDF, HMAC, SHA-256, ECDSA, TLS, and constant-time
  comparison come from Node's built-in OpenSSL.
- **Where untrusted input meets a dependency.** `asn1js` parses only the
  serialized session that the local OpenSSL produced after a completed
  handshake; `@peculiar/x509` runs only when the identity is first created.
  Untrusted network bytes reach only the companion's own strict JSON parser
  (`src/json.mjs`: UTF-8, no duplicate keys, depth limits, prototype-free
  objects) and the contract validator.
- **What a compromised dependency could do:** issue a weak or wrong node
  certificate (the device would pin it during pairing), or misreport EMS on
  TLS 1.2. Both are confined to this process; the companion holds no journal
  data at rest.

## Tests

```sh
npm test                                   # 33 tests
node scripts/engine-golden.mjs --check     # pinned engine outputs
node scripts/load.mjs --fixture max        # development load run
```

The pairing tests read the SDK's published vectors from
`$HYBRID_AI_SDK_REPO` (default `../../hybridAi`) read only.
