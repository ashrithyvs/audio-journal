# `journal.organize@1` Contract

**Status:** Frozen for implementation on 2026-10-11 (ADR-019), except the
items in §12, which stay Open and block only the work named there.
**Owner:** Audio Journal (ADR-010, ADR-018). The Hybrid AI SDK carries this
capability as an opaque node capability; it is not part of the SDK.

**Normative artifacts** (`schemas/journal/v1/`):

- `organize-input.schema.json`: the request input (JSON Schema, Draft 7);
- `organize-output.schema.json`: the result (JSON Schema, Draft 7);
- `organize-partial.schema.json`: the streamed `partial` delta;
- `vectors.json` and its case files: deterministic test vectors, rebuilt by
  `tools/journal-organize/generate-vectors.mjs --check` and checked
  independently by `tools/journal-organize/verify_vectors.py`.

JSON Schema expresses the shape. The cross-field rules in §6 (references,
digests, ranges, order, duplicates) are normative too; they cannot be stated
in Draft 7 and are checked by the app and the independent verifier.

## 1. Capability and execution

| Field | Value |
|---|---|
| `id` | `journal.organize` |
| `version` | `1.0.0` (the SDK sends the major only and binds the highest `1.x.y` the node advertises) |
| `inputSchema`, `outputSchema` | the two schema files above, inline in the node's `/v1/capabilities` |
| `streaming` | `true` (otherwise the SDK drops progress and partial events) |
| `maximumInputBytes` | `61440` |
| `preferred` | `node` |

- **Execution is `node` only.** The app calls the SDK's public `stream()`
  with `execution: 'node'`. There is no local organize engine (ADR-018: the
  app bundles no inference runtime for organization), so the app never uses
  `local` or `auto` for this capability and never falls back.
- **`document.analyze@1` is never used as a substitute.**
- **Deadline.** The app sends `timeoutMs: 60000`. The node arms the deadline
  once, at acceptance (SDK ADR-021).

## 2. Request input

The input is one JSON object. Its canonical form (keys sorted, compact,
UTF-8; §8) is at most **61,440 bytes**. The app refuses to send a larger
selection and says so; it never truncates content.

```json
{
  "contract": "journal.organize@1",
  "requestKey": "org_0123456789abcdefghjkmnpqrs",
  "locale": "en-IN",
  "timeZone": "Asia/Kolkata",
  "kinds": ["summary", "sections", "tasks", "ideas", "people", "projects"],
  "entries": [
    {
      "entryId": "ent_…",
      "kind": "voice",
      "createdAt": "2026-10-10T09:15:00.000Z",
      "recordingId": "rec_…",
      "transcriptRevision": 1,
      "durationMs": 61000,
      "units": [
        { "unitId": "seg_…", "text": "…", "sha256": "…", "startMs": 0, "endMs": 4200 }
      ]
    },
    {
      "entryId": "ent_…",
      "kind": "written",
      "createdAt": "2026-10-10T18:02:11.000Z",
      "units": [{ "unitId": "w0", "text": "…", "sha256": "…", "offset": 0 }]
    }
  ]
}
```

- **`contract`**: the constant `journal.organize@1`.
- **`requestKey`**: `org_` plus 26 Crockford base32 characters, new for every
  user action (§9).
- **`locale`**: `^[a-z]{2,3}(-[A-Z]{2})?$`. **`timeZone`**: an IANA name,
  `^[A-Za-z]+(/[A-Za-z0-9_+-]+){0,2}$`, or `UTC`. Both are context only; v1
  derives no dates (§12, O-1).
- **`kinds`**: 1–6 unique values from `summary`, `sections`, `tasks`,
  `ideas`, `people`, `projects`, in that order.
- **`entries`**: 1–20, ordered by `createdAt`, then `entryId`; no duplicate
  `entryId`. `createdAt` is UTC with milliseconds
  (`YYYY-MM-DDTHH:MM:SS.mmmZ`).
- **Voice entries** carry `recordingId`, `transcriptRevision` (the engine
  revision of the full pass, 1–1,000,000), and `durationMs`. Their units are
  the current transcript lines: the newest full engine pass, each line at
  the head of its correction chain (state `final` or `corrected`).
  - `unitId` is that head segment's record ID (`seg_…`), so a corrected line
    is cited by its correction row.
  - `startMs` and `endMs` are the engine segment's range, with
    `0 ≤ startMs < endMs ≤ durationMs`.
  - Provisional (live) text, superseded rows, and entries whose recording
    is not `ready` or has no full pass are never sent.
- **Written entries** carry no recording fields. Their units are the
  entry's paragraphs: the source text is split at blank lines, a paragraph
  longer than 4,000 UTF-16 code units is split at the last sentence end
  (`.`, `!`, `?` followed by a space) inside the limit, else at 4,000
  without splitting a surrogate pair, and whitespace-only pieces are
  dropped. `unitId` is `w0`, `w1`, … in order, and `offset` is the piece's
  UTF-16 offset in the entry's source text, so every unit is the exact
  substring `sourceText.slice(offset, offset + text.length)`.
- **Units**: 1–400 per entry and 1–400 in total; `unitId` unique within its
  entry; `text` 1–4,000 UTF-16 code units, well-formed UTF-16, no C0/C1
  control characters except LF and TAB (written text only), no bidi
  override or isolate characters (U+202A–U+202E, U+2066–U+2069); `sha256`
  is lower-case hex of SHA-256 over the UTF-8 bytes of `text`.
- **Empty input.** A selection with no sendable unit is not sent; the app
  says there is nothing to organize yet.

Only this content leaves the device: the selected entries' finalized text,
their opaque IDs, creation times, segment timings, and the context fields
above. Audio, recording files, paths, keys, other entries, titles, task
states, and earlier derivations are never sent. The IDs are random and carry
no personal information; they are needed so results can cite their sources.

## 3. Result

```json
{
  "contract": "journal.organize@1",
  "requestKey": "org_0123456789abcdefghjkmnpqrs",
  "inputSha256": "…",
  "engine": { "id": "aj.rules", "version": "1.0.0" },
  "summary": { "text": "…", "sources": [ … ] },
  "sections": [{ "area": "work", "items": [{ "text": "…", "rule": "area.work", "sources": [ … ] }] }],
  "tasks": [{ "text": "…", "area": "work", "rule": "task.need-to", "sources": [ … ] }],
  "ideas": [{ "text": "…", "sources": [ … ] }],
  "people": [{ "name": "…", "sources": [ … ] }],
  "projects": [{ "name": "…", "sources": [ … ] }]
}
```

- **Echo.** `contract`, `requestKey`, and `inputSha256` (SHA-256 of the
  canonical input, §8) must equal the request's. This binds a result to the
  exact content it was computed from.
- **`engine`**: `id` `^[a-z][a-z0-9.-]{0,31}$` and a `major.minor.patch`
  `version`. It identifies the rules for explainability; it is not a model
  name and is not shown as an agent identity.
- **Kinds.** Exactly the requested kinds appear, and no others. A requested
  list kind is always present, possibly empty. `summary`, when requested, is
  always present.
- **`sections`**: at most one item list per area, `work` before `personal`;
  an area with no items is omitted.
- **Items.** `text` (summary up to 600, items up to 400, `name` up to 80
  UTF-16 code units), an optional `rule` (`^[a-z][a-z0-9.-]{0,47}$`, the
  engine rule that produced it), and `sources`, 1–8 references. Tasks also
  carry `area`: `work`, `personal`, or `unsorted`.
- **Bounds.** At most 50 items per list and per section, 1,000 references
  in total, and 61,440 bytes in canonical form (the SDK carries the whole
  `completed` event in one WebSocket frame).
- **Text.** Single-line, well-formed UTF-16, no control, bidi override, or
  isolate characters, and not blank. The app renders it as plain text
  (security §7); it is never executed or followed.

### 3.1 Source references

Every derived item cites its evidence. There is no unattributed output.

```json
{ "entryId": "ent_…", "unitId": "seg_…", "unitSha256": "…",
  "charStart": 12, "charEnd": 48, "audioStartMs": 1200, "audioEndMs": 4200 }
```

- `entryId` and `unitId` name a unit of the request; `unitSha256` equals that
  unit's `sha256`.
- `charStart` and `charEnd` are UTF-16 code-unit offsets into the unit's
  `text`, half-open, `0 ≤ charStart < charEnd ≤ text.length`, and neither
  splits a surrogate pair. For a written unit, the entry offset is
  `offset + charStart`.
- A voice reference must carry `audioStartMs` and `audioEndMs`, half-open,
  with `unit.startMs ≤ audioStartMs < audioEndMs ≤ unit.endMs`. Transcripts
  have segment-level timing only, so the v1 engine cites the whole segment
  range; a later engine may narrow it. A written reference must not carry
  audio fields.
- The transcript revision is the entry's `transcriptRevision`, and the
  recording is its `recordingId`; references do not repeat them.
- Within one item, references are ordered by entry order, then unit order,
  then `charStart`; they are unique, and two references to the same unit do
  not overlap.

Different items may cite the same evidence: one sentence may be both a task
and a Work item.

## 4. Events

Through the SDK, a run delivers `accepted`, then any `progress` and `partial`
events, then exactly one terminal: `completed`, `failed`, or `cancelled`.

- **`progress`** `data`: `{stage, fraction?}` with `stage` one of
  `received`, `segmenting`, `extracting`, `checking`.
- **`partial`** `data.delta` (`organize-partial.schema.json`):
  `{"counts": {…}}`, the number of items found so far per requested kind.
  Partials carry no content and are never persisted.
- **`failed`**: SDK codes only (a node may send `EXECUTION_FAILED`,
  `DEADLINE_EXCEEDED`, `SCHEMA_VALIDATION_FAILED`, or `CANCELLED`). The app
  keeps the code, never the message.
- **App rules:** events after the terminal are ignored; a `completed` result
  is validated (§6) before anything is stored; any failure, cancellation,
  invalid result, or partial-then-failure stores nothing and changes no
  source. Status hooks from AJ-3 still apply (UX §7.1).

## 5. Deadlines and cancellation

- The node checks its deadline between stages and fails with
  `DEADLINE_EXCEEDED`. The app's own deadline is the SDK `timeoutMs`.
- The user can cancel at any time; the app calls the SDK's `cancel`, shows
  "Cancelled", and stores nothing. Locking the app cancels a running
  organize like any node request.
- The node never retries; the app never retries automatically (AJ-3).

## 6. Result validation (normative order)

The app validates a `completed` output in this order and stops at the first
violation. The result is then discarded with `INVALID_RESULT` and the local
diagnostic sub-code below; no text or detail is logged. The independent
verifier reports the same sub-code for every vector.

| # | Sub-code | Rule |
|---|---|---|
| 1 | `RESULT_SIZE` | The canonical output is at most 61,440 bytes, and nesting depth is at most 8. |
| 2 | `RESULT_SCHEMA` | The output matches `organize-output.schema.json`: types, required and unknown fields, enums, patterns, lengths, and counts. Keys `__proto__`, `constructor`, and `prototype` are unknown fields. |
| 3 | `RESULT_ECHO` | `contract`, `requestKey`, and `inputSha256` equal the request's. |
| 4 | `RESULT_KINDS` | Exactly the requested kinds are present; sections are ordered and unique. |
| 5 | `RESULT_TEXT` | Every text is well-formed, single-line, free of control, bidi override, and isolate characters, and not blank. |
| 6 | `RESULT_REFERENCE` | Every `entryId` and `unitId` names a unit in the request. |
| 7 | `RESULT_DIGEST` | Every `unitSha256` equals the cited unit's `sha256`. |
| 8 | `RESULT_RANGE` | Character ranges are inside the unit and do not split a surrogate pair; voice references carry an audio range inside the unit; written references carry none. |
| 9 | `RESULT_ORDER` | Within an item, references are ordered, unique, and non-overlapping per unit. |
| 10 | `RESULT_DUPLICATE` | Within a list or section, no two items have the same normalized text (NFC, lower-case, whitespace collapsed). |

Checks run over the output in document order: `summary`, `sections`,
`tasks`, `ideas`, `people`, `projects`. Request inputs are validated the same
way by the node (`organize-input.schema.json` plus §2), and an invalid input
fails with `SCHEMA_VALIDATION_FAILED`.

## 7. Persistence

After a valid `completed`, the app writes in one transaction (LLD §4):

- one `derivations` row: the derivation ID, `requestKey` (unique), the
  contract, engine ID and version, `inputSha256`, the canonical result, the
  creation time, and a `revision` number, one higher than the latest
  derivation with exactly the same set of entries;
- its scope (`derivation_entries`);
- one `derived_tasks` row per task, state `open` (task state is application
  data, not source);
- one `source_references` row per reference, with the item kind and index,
  and the cited segment's ID for voice references.

Derivation rows and references are immutable; reorganizing creates a new
revision and never edits or deletes an earlier one. Source entries,
recordings, and transcripts are never written by this flow. A transcript
corrected later does not change a derivation: its references keep the exact
segment rows and digests they cited (§12, O-2 decides how stale results are
shown).

## 8. Canonical JSON and digests

Canonical JSON is compact, with object keys sorted by UTF-16 code units,
strings escaped minimally (`"`, `\`, and control characters as `\uXXXX`
except `\b \f \n \r \t`), integers without fractions or exponents, and no
non-integer numbers. `inputSha256` and the 61,440-byte limits use the UTF-8
bytes of this form. Parsers reject duplicate keys, trailing data, nesting
deeper than 32, and invalid UTF-8.

## 9. Idempotency and retry safety

- **SDK level.** The SDK creates one idempotency key per `stream()` call and
  the node replays a job for the same key and body (SDK ADR-021).
- **App level.** `requestKey` is unique per user action and unique in
  `derivations`, so one action can never be stored twice, even if a result
  were delivered twice.
- **Node level.** The node keeps a completed result for `(pairing,
  requestKey)` for the job retention window and returns it again for the same
  `inputSha256`; the same `requestKey` with a different input fails with
  `EXECUTION_FAILED`.
- **Retry.** "Try again" is a new action with a new `requestKey`. Because the
  engine is deterministic, the same input gives byte-identical output.

## 10. Node companion obligations

The companion (`node-companion/`, ADR-018) is a Private AI Node in its own
right. For this capability it must: advertise the descriptor in §1;
validate every input (§2, §6 order for inputs); produce only results that
pass §6; keep job inputs and results in memory only, for at most the
protocol's retention (32 jobs, 15 minutes); and log no journal content, only
codes, counts, and durations.

## 11. Decisions resolving earlier documents (ADR-019)

1. **Execution** is `node` only for this capability; LLD/HLD `local | auto`
   wording applies to other capabilities.
2. **Error code** is `INVALID_RESULT` (`AI_RESULT_INVALID` in LLD §10 was a
   draft name).
3. **Character ranges** are UTF-16 code units over the exact stored text,
   per unit; written references add the unit's `offset`.
4. **Every item cites evidence** (ADR-018); voice references always carry an
   audio range (ADR-002, AJ-FR-013/025).
5. **References are plural**: 1–8 per item.
6. **"Exact" audio range** means inside the cited segment's range; with
   segment-level timing, v1 cites the whole segment.
7. **Finalized text** is the current transcript: newest full pass, correction
   heads; only `ready` recordings.
8. **Output kinds** are those of ADR-018; "topics" is not in v1. Work and
   Personal are one selectable kind, `sections`.
9. **Consent** is asked before every organize run, naming the selection, the
   active paired node, and that text, not audio, is sent. No acknowledgement
   is stored.
10. **Selection** is whole entries, 1–20, within the size limit.
11. **IDs** sent are the real opaque local IDs.

## 12. Open questions (not frozen)

| ID | Question | Blocks |
|---|---|---|
| O-1 | Due dates: whether and how tasks carry dates (deterministic phrase rules vs none), and time-zone semantics. | Tasks grouping by date in the next UI stage; v1 tasks carry no date. |
| O-2 | How an older derivation is shown after its source transcript is corrected or re-transcribed (badge, hide, or offer reorganize), and which revision the Organized view shows. | The Organized view (next stage). |
| O-3 | Editing derived items, and carrying task done/dismissed state across a reorganize. | The Tasks UI (next stage). |
| O-4 | Retention and deletion of derivations and tasks (Open decision 6). | Deletion features; nothing is deleted in v1. |
| O-5 | Including derivations and task states in backups (AJB1 domain schema v2, reserved). Until then backups do not carry them, and a restore has none. | AJB1 v2. |
| O-6 | Whether the companion also serves `document.analyze@1`, so the AJ-3 diagnostics test works against it. | Diagnostics against the companion only. |
| O-7 | Companion TLS 1.2 with EMS for Android 8.0–9 (API 26–28). v1 accepts TLS 1.3 only. | Pairing from Android 9 and older. |
