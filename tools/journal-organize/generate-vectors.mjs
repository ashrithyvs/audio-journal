// journal.organize@1 schemas and test vectors (docs/journal-organize.md).
//
// The single source of the pinned schema files and of every vector in
// schemas/journal/v1/. Each case states its expected verdict and, when
// invalid, the first failing rule's sub-code (contract §6 and §6.1). The
// verdicts are written here by hand from the contract; they are checked
// independently by verify_vectors.py and by the app and companion test
// suites, none of which share code with this file.
//
//   node generate-vectors.mjs           write the files
//   node generate-vectors.mjs --check   rebuild in memory and compare bytes

import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'schemas', 'journal', 'v1');
const CHECK = process.argv.includes('--check');

// ---------------------------------------------------------------- helpers

/** Canonical JSON: sorted keys, compact (contract §8). */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const pretty = value => `${JSON.stringify(value, null, 2)}\n`;

const B32 = '0123456789abcdefghjkmnpqrstvwxyz';

// Message budget (contract §8.1).
const MESSAGE_CAP = 61_440;
const REQUEST_ENVELOPE_MAX = 332;
const EVENT_ENVELOPE = 53;
const INPUT_CAP = MESSAGE_CAP - REQUEST_ENVELOPE_MAX; // 61,108
const OUTPUT_CAP = MESSAGE_CAP - EVENT_ENVELOPE; // 61,387
const bytes = value => Buffer.byteLength(canonical(value), 'utf8');

/** The public test key for request-key vectors (never used by the app). */
const TEST_KEY = createHash('sha256')
  .update('journal.organize@1 test key')
  .digest();

/** Contract §9: org_ + base32(HMAC-SHA256(K, label 0x00 canonical-without-key))[0..26]. */
function requestKey(key, input) {
  const rest = { ...input };
  delete rest.requestKey;
  const mac = createHmac('sha256', key)
    .update(
      Buffer.concat([
        Buffer.from('journal.organize@1', 'utf8'),
        Buffer.from([0]),
        Buffer.from(canonical(rest), 'utf8'),
      ]),
    )
    .digest();
  let bits = '';
  for (const byte of mac) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < 26; i += 1)
    out += B32[parseInt(bits.slice(i * 5, i * 5 + 5), 2)];
  return `org_${out}`;
}
const rekey = input => {
  input.requestKey = requestKey(TEST_KEY, input);
  return input;
};
/** A deterministic, valid local ID: prefix plus 26 base32 characters. */
function id(prefix, n) {
  let tail = '';
  let v = n;
  for (let i = 0; i < 26; i += 1) {
    tail = B32[v % 32] + tail;
    v = Math.floor(v / 32);
  }
  return `${prefix}_${tail}`;
}

// ---------------------------------------------------------------- schemas

const ID = prefix => ({
  type: 'string',
  pattern: `^${prefix}_[0-9a-hjkmnp-tv-z]{26}$`,
});
const HEX64 = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const MAX_MS = 3_600_000;
const KINDS = ['summary', 'sections', 'tasks', 'ideas', 'people', 'projects'];

const inputSchema = (() => {
  const text = { type: 'string', minLength: 1, maxLength: 4000 };
  const createdAt = {
    type: 'string',
    pattern:
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$',
  };
  const voiceUnit = {
    type: 'object',
    additionalProperties: false,
    required: ['unitId', 'text', 'sha256', 'startMs', 'endMs'],
    properties: {
      unitId: ID('seg'),
      text,
      sha256: HEX64,
      startMs: { type: 'integer', minimum: 0, maximum: MAX_MS - 1 },
      endMs: { type: 'integer', minimum: 1, maximum: MAX_MS },
    },
  };
  const writtenUnit = {
    type: 'object',
    additionalProperties: false,
    required: ['unitId', 'text', 'sha256', 'offset'],
    properties: {
      unitId: { type: 'string', pattern: '^w[0-9]{1,3}$' },
      text,
      sha256: HEX64,
      offset: { type: 'integer', minimum: 0, maximum: 199_999 },
    },
  };
  const units = item => ({
    type: 'array',
    minItems: 1,
    maxItems: 400,
    items: item,
  });
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://audio-journal.invalid/schemas/journal/v1/organize-input.schema.json',
    title: 'journal.organize@1 request input',
    type: 'object',
    additionalProperties: false,
    required: [
      'contract',
      'requestKey',
      'locale',
      'timeZone',
      'kinds',
      'entries',
    ],
    properties: {
      contract: { const: 'journal.organize@1' },
      requestKey: ID('org'),
      locale: { type: 'string', pattern: '^[a-z]{2,3}(-[A-Z]{2})?$' },
      timeZone: {
        type: 'string',
        pattern: '^(UTC|[A-Za-z]+(/[A-Za-z0-9_+-]+){0,2})$',
        maxLength: 64,
      },
      kinds: {
        type: 'array',
        minItems: 1,
        maxItems: 6,
        uniqueItems: true,
        items: { enum: KINDS },
      },
      entries: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: [
                'entryId',
                'kind',
                'createdAt',
                'recordingId',
                'transcriptRevision',
                'durationMs',
                'units',
              ],
              properties: {
                entryId: ID('ent'),
                kind: { const: 'voice' },
                createdAt,
                recordingId: ID('rec'),
                transcriptRevision: {
                  type: 'integer',
                  minimum: 1,
                  maximum: 1_000_000,
                },
                durationMs: { type: 'integer', minimum: 1, maximum: MAX_MS },
                units: units(voiceUnit),
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['entryId', 'kind', 'createdAt', 'units'],
              properties: {
                entryId: ID('ent'),
                kind: { const: 'written' },
                createdAt,
                units: units(writtenUnit),
              },
            },
          ],
        },
      },
    },
  };
})();

const outputSchema = (() => {
  const ref = {
    type: 'object',
    additionalProperties: false,
    required: ['entryId', 'unitId', 'unitSha256', 'charStart', 'charEnd'],
    properties: {
      entryId: ID('ent'),
      unitId: {
        type: 'string',
        pattern: '^(seg_[0-9a-hjkmnp-tv-z]{26}|w[0-9]{1,3})$',
      },
      unitSha256: HEX64,
      charStart: { type: 'integer', minimum: 0, maximum: 3999 },
      charEnd: { type: 'integer', minimum: 1, maximum: 4000 },
      audioStartMs: { type: 'integer', minimum: 0, maximum: MAX_MS - 1 },
      audioEndMs: { type: 'integer', minimum: 1, maximum: MAX_MS },
    },
  };
  const sources = { type: 'array', minItems: 1, maxItems: 8, items: ref };
  const rule = { type: 'string', pattern: '^[a-z][a-z0-9.-]{0,47}$' };
  const item = max => ({
    type: 'object',
    additionalProperties: false,
    required: ['text', 'sources'],
    properties: {
      text: { type: 'string', minLength: 1, maxLength: max },
      rule,
      sources,
    },
  });
  const named = {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'sources'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 80 },
      rule,
      sources,
    },
  };
  const list = itemSchema => ({
    type: 'array',
    maxItems: 50,
    items: itemSchema,
  });
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://audio-journal.invalid/schemas/journal/v1/organize-output.schema.json',
    title: 'journal.organize@1 result',
    type: 'object',
    additionalProperties: false,
    required: ['contract', 'requestKey', 'inputSha256', 'engine', 'completeness'],
    properties: {
      contract: { const: 'journal.organize@1' },
      requestKey: ID('org'),
      inputSha256: HEX64,
      engine: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'version'],
        properties: {
          id: { type: 'string', pattern: '^[a-z][a-z0-9.-]{0,31}$' },
          version: {
            type: 'string',
            pattern: '^[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}$',
          },
        },
      },
      summary: item(600),
      sections: {
        type: 'array',
        maxItems: 2,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['area', 'items'],
          properties: {
            area: { enum: ['work', 'personal'] },
            items: {
              type: 'array',
              minItems: 1,
              maxItems: 50,
              items: item(400),
            },
          },
        },
      },
      tasks: list({
        type: 'object',
        additionalProperties: false,
        required: ['text', 'area', 'sources'],
        properties: {
          text: { type: 'string', minLength: 1, maxLength: 400 },
          area: { enum: ['work', 'personal', 'unsorted'] },
          rule,
          sources,
        },
      }),
      ideas: list(item(400)),
      people: list(named),
      projects: list(named),
      // Amendment A1 (§3.2): a result says whether it carries everything the
      // engine found; `omitted` counts the lowest-ranked items left out.
      completeness: { enum: ['complete', 'partial'] },
      omitted: {
        type: 'object',
        additionalProperties: false,
        minProperties: 1,
        properties: Object.fromEntries(
          ['sections', 'tasks', 'ideas', 'people', 'projects'].map(k => [
            k,
            { type: 'integer', minimum: 1, maximum: 100000 },
          ]),
        ),
      },
    },
  };
})();

const partialSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://audio-journal.invalid/schemas/journal/v1/organize-partial.schema.json',
  title: 'journal.organize@1 partial delta',
  type: 'object',
  additionalProperties: false,
  required: ['counts'],
  properties: {
    counts: {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      properties: {
        summary: { type: 'integer', minimum: 0, maximum: 1 },
        sections: { type: 'integer', minimum: 0, maximum: 100 },
        tasks: { type: 'integer', minimum: 0, maximum: 50 },
        ideas: { type: 'integer', minimum: 0, maximum: 50 },
        people: { type: 'integer', minimum: 0, maximum: 50 },
        projects: { type: 'integer', minimum: 0, maximum: 50 },
      },
    },
  },
};

// ---------------------------------------------------------------- fixtures

function voiceEntry(
  n,
  createdAt,
  lines,
  { revision = 1, firstSeg = n * 100 } = {},
) {
  let at = 0;
  const units = lines.map((line, i) => {
    const text = typeof line === 'string' ? line : line.text;
    const ms = typeof line === 'string' ? 4000 : line.ms;
    const unit = {
      unitId:
        typeof line === 'string' || !line.segId
          ? id('seg', firstSeg + i)
          : line.segId,
      text,
      sha256: sha256(text),
      startMs: at,
      endMs: at + ms,
    };
    at += ms;
    return unit;
  });
  return {
    entryId: id('ent', n),
    kind: 'voice',
    createdAt,
    recordingId: id('rec', n),
    transcriptRevision: revision,
    durationMs: at + 500,
    units,
  };
}

/** Written units as the app splits them (contract §2): paragraphs at blank lines. */
function writtenEntry(n, createdAt, sourceText) {
  const units = [];
  const re = /[^\n]+(?:\n(?![ \t]*\n)[^\n]*)*/g;
  for (const match of sourceText.matchAll(re)) {
    const raw = match[0];
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (!text) continue;
    units.push({
      unitId: `w${units.length}`,
      text,
      sha256: sha256(text),
      offset: match.index + lead,
    });
  }
  return { entryId: id('ent', n), kind: 'written', createdAt, units };
}

function request(entries, kinds = KINDS) {
  return rekey({
    contract: 'journal.organize@1',
    requestKey: '',
    locale: 'en-IN',
    timeZone: 'Asia/Kolkata',
    kinds,
    entries,
  });
}

const W1 = writtenEntry(
  1,
  '2026-10-09T08:30:00.000Z',
  'Quarterly report review with the client went well.\n\nI need to send the revised budget to Priya by Friday.\n\nAfter work I want to call Mom about the birthday dinner.',
);
const W2 = writtenEntry(
  2,
  '2026-10-09T20:15:00.000Z',
  'Idea: a weekend reading club for the neighbourhood.\n\nRemember to book the dentist appointment.',
);
const V1 = voiceEntry(3, '2026-10-10T07:05:00.000Z', [
  'Morning stand-up with the design team about Project Atlas.',
  'I have to finish the onboarding slides before the sprint demo.',
  'What if we tried pairing on the hard bugs every Thursday.',
  'Pick up groceries and the dry cleaning on the way home.',
]);
const CORRECTED_SEG = id('seg', 9001);
const V2 = voiceEntry(
  4,
  '2026-10-10T19:40:00.000Z',
  [
    'Long walk with Arjun in the park this evening.',
    {
      text: 'We should plan the Goa trip for December.',
      ms: 3500,
      segId: CORRECTED_SEG,
    },
    'Need to renew the car insurance this week.',
  ],
  { revision: 2 },
);
const U1 = writtenEntry(
  5,
  '2026-10-10T21:00:00.000Z',
  'Café meeting 😀 with Zoë about the naïve plan.\n\n東京 trip notes — remember to email Hiroshi.\n\nمرحبا from the language class 👩‍💻 today.',
);
const U2 = voiceEntry(6, '2026-10-10T22:00:00.000Z', [
  'Celebrated the 🎉 launch with the whole team.',
]);

/** Pads or trims the last unit so the canonical input is exactly `target` bytes. */
function sizeInputTo(req, target) {
  const entry = req.entries[req.entries.length - 1];
  const unit = entry.units[entry.units.length - 1];
  for (let guard = 0; guard < 100_000; guard += 1) {
    rekey(req);
    const diff = target - bytes(req);
    if (diff === 0) return req;
    unit.text =
      diff > 0
        ? unit.text + 'x'.repeat(Math.min(diff, 4000 - unit.text.length))
        : unit.text.slice(0, diff);
    unit.sha256 = sha256(unit.text);
  }
  throw new Error('could not size the input');
}

/** A request exactly at the 61,108-byte input cap. */
function maxRequest() {
  const entries = [];
  let n = 100;
  const make = len => {
    const base = 'Planning notes for the quarterly review with the team. ';
    let text = '';
    while (text.length < len) text += base;
    return text.slice(0, len).trimEnd() + '.';
  };
  for (let e = 0; e < 20; e += 1) {
    entries.push(
      writtenEntry(
        n + e,
        `2026-10-01T00:${String(e).padStart(2, '0')}:00.000Z`,
        [make(1300), make(1300)].join('\n\n'),
      ),
    );
  }
  return sizeInputTo(request(entries), INPUT_CAP);
}

const FIXTURES = {
  written: request([W1, W2]),
  voice: request([V1]),
  mixed: request([W1, W2, V1, V2]),
  corrected: request([V2], ['tasks', 'people']),
  unicode: request([U1, U2], ['summary', 'tasks', 'people']),
  summaryOnly: request([W1], ['summary']),
  max: maxRequest(),
};

// ---------------------------------------------------------------- results

function unitOf(req, entryIndex, unitIndex) {
  const entry = req.entries[entryIndex];
  return { entry, unit: entry.units[unitIndex] };
}

/** A reference to `phrase` inside one unit (UTF-16 offsets). */
function ref(req, entryIndex, unitIndex, phrase) {
  const { entry, unit } = unitOf(req, entryIndex, unitIndex);
  const start = phrase === undefined ? 0 : unit.text.indexOf(phrase);
  if (start < 0) throw new Error(`"${phrase}" not in ${unit.unitId}`);
  const end = phrase === undefined ? unit.text.length : start + phrase.length;
  const out = {
    entryId: entry.entryId,
    unitId: unit.unitId,
    unitSha256: unit.sha256,
    charStart: start,
    charEnd: end,
  };
  if (entry.kind === 'voice') {
    out.audioStartMs = unit.startMs;
    out.audioEndMs = unit.endMs;
  }
  return out;
}

function envelope(req) {
  return {
    contract: 'journal.organize@1',
    requestKey: req.requestKey,
    inputSha256: sha256(canonical(req)),
    engine: { id: 'aj.rules', version: '1.0.0' },
    completeness: 'complete',
  };
}

function validMixed() {
  const r = FIXTURES.mixed;
  return {
    ...envelope(r),
    summary: {
      text: 'Client report review, budget and onboarding work, and planning a December trip.',
      rule: 'summary.lead',
      sources: [ref(r, 0, 0), ref(r, 2, 0), ref(r, 3, 1)],
    },
    sections: [
      {
        area: 'work',
        items: [
          {
            text: 'Quarterly report review with the client went well.',
            rule: 'area.work',
            sources: [ref(r, 0, 0)],
          },
          {
            text: 'Morning stand-up with the design team about Project Atlas.',
            rule: 'area.work',
            sources: [ref(r, 2, 0)],
          },
        ],
      },
      {
        area: 'personal',
        items: [
          {
            text: 'Long walk with Arjun in the park this evening.',
            rule: 'area.personal',
            sources: [ref(r, 3, 0)],
          },
        ],
      },
    ],
    tasks: [
      {
        text: 'Send the revised budget to Priya by Friday.',
        area: 'work',
        rule: 'task.need-to',
        sources: [ref(r, 0, 1, 'send the revised budget to Priya by Friday')],
      },
      {
        text: 'Finish the onboarding slides before the sprint demo.',
        area: 'work',
        rule: 'task.have-to',
        sources: [ref(r, 2, 1)],
      },
      {
        text: 'Renew the car insurance this week.',
        area: 'personal',
        rule: 'task.need-to',
        sources: [ref(r, 3, 2)],
      },
      {
        text: 'Book the dentist appointment.',
        area: 'unsorted',
        rule: 'task.remember',
        sources: [ref(r, 1, 1)],
      },
    ],
    ideas: [
      {
        text: 'A weekend reading club for the neighbourhood.',
        rule: 'idea.prefix',
        sources: [ref(r, 1, 0)],
      },
      {
        text: 'Pair on the hard bugs every Thursday.',
        rule: 'idea.what-if',
        sources: [ref(r, 2, 2)],
      },
    ],
    people: [
      {
        name: 'Priya',
        rule: 'person.after-verb',
        sources: [ref(r, 0, 1, 'Priya')],
      },
      { name: 'Arjun', rule: 'person.with', sources: [ref(r, 3, 0, 'Arjun')] },
    ],
    projects: [
      {
        name: 'Atlas',
        rule: 'project.named',
        sources: [ref(r, 2, 0, 'Project Atlas')],
      },
    ],
  };
}

const VALID = {
  written: () => {
    const r = FIXTURES.written;
    return {
      ...envelope(r),
      summary: {
        text: 'A client review, a budget follow-up, and family plans.',
        sources: [ref(r, 0, 0), ref(r, 0, 2)],
      },
      sections: [
        {
          area: 'work',
          items: [
            {
              text: 'Quarterly report review with the client went well.',
              sources: [ref(r, 0, 0)],
            },
          ],
        },
        {
          area: 'personal',
          items: [
            {
              text: 'Call Mom about the birthday dinner.',
              sources: [ref(r, 0, 2, 'call Mom about the birthday dinner')],
            },
          ],
        },
      ],
      tasks: [
        {
          text: 'Send the revised budget to Priya by Friday.',
          area: 'work',
          sources: [ref(r, 0, 1)],
        },
        {
          text: 'Book the dentist appointment.',
          area: 'personal',
          sources: [ref(r, 1, 1)],
        },
      ],
      ideas: [
        {
          text: 'A weekend reading club for the neighbourhood.',
          sources: [ref(r, 1, 0)],
        },
      ],
      people: [
        { name: 'Priya', sources: [ref(r, 0, 1, 'Priya')] },
        { name: 'Mom', sources: [ref(r, 0, 2, 'Mom')] },
      ],
      projects: [],
    };
  },
  voice: () => {
    const r = FIXTURES.voice;
    return {
      ...envelope(r),
      summary: {
        text: 'Stand-up, onboarding slides, and errands.',
        sources: [ref(r, 0, 0), ref(r, 0, 1), ref(r, 0, 3)],
      },
      sections: [
        {
          area: 'work',
          items: [
            { text: 'Stand-up about Project Atlas.', sources: [ref(r, 0, 0)] },
          ],
        },
      ],
      tasks: [
        {
          text: 'Finish the onboarding slides.',
          area: 'work',
          sources: [ref(r, 0, 1, 'finish the onboarding slides')],
        },
        {
          text: 'Pick up groceries and the dry cleaning.',
          area: 'personal',
          sources: [ref(r, 0, 3)],
        },
      ],
      ideas: [
        {
          text: 'Pair on the hard bugs every Thursday.',
          sources: [ref(r, 0, 2)],
        },
      ],
      people: [],
      projects: [{ name: 'Atlas', sources: [ref(r, 0, 0, 'Project Atlas')] }],
    };
  },
  mixed: validMixed,
  corrected: () => {
    const r = FIXTURES.corrected;
    return {
      ...envelope(r),
      tasks: [
        {
          text: 'Plan the Goa trip for December.',
          area: 'personal',
          sources: [ref(r, 0, 1)],
        },
        {
          text: 'Renew the car insurance this week.',
          area: 'personal',
          sources: [ref(r, 0, 2)],
        },
      ],
      people: [{ name: 'Arjun', sources: [ref(r, 0, 0, 'Arjun')] }],
    };
  },
  unicode: () => {
    const r = FIXTURES.unicode;
    return {
      ...envelope(r),
      summary: {
        text: 'Café 😀 meeting, 東京 notes, and a 🎉 launch.',
        sources: [
          ref(r, 0, 0, 'Café meeting 😀'),
          ref(r, 0, 1, '東京'),
          ref(r, 1, 0, '🎉'),
        ],
      },
      tasks: [
        {
          text: 'Email Hiroshi.',
          area: 'unsorted',
          sources: [ref(r, 0, 1, 'email Hiroshi')],
        },
      ],
      people: [
        { name: 'Zoë', sources: [ref(r, 0, 0, 'Zoë')] },
        { name: 'Hiroshi', sources: [ref(r, 0, 1, 'Hiroshi')] },
      ],
    };
  },
  summaryOnly: () => {
    const r = FIXTURES.summaryOnly;
    return {
      ...envelope(r),
      summary: {
        text: 'A client review and two follow-ups.',
        sources: [ref(r, 0, 0)],
      },
    };
  },
  emptyLists: () => {
    const r = FIXTURES.corrected;
    return { ...envelope(r), tasks: [], people: [] };
  },
  maxOutput: () => sizeOutputTo(fillOutput(), OUTPUT_CAP),
  // Amendment A1 (§3.2): explicitly partial results, one at the output cap.
  partial: () => ({
    ...validMixed(),
    completeness: 'partial',
    omitted: { tasks: 2, ideas: 1 },
  }),
  maxOutputPartial: () =>
    sizeOutputTo(
      fillOutput({ completeness: 'partial', omitted: { tasks: 7, ideas: 9 } }),
      OUTPUT_CAP,
    ),
};

/** As many distinct items as fit under the output cap. */
function fillOutput(extra = {}) {
  const r = FIXTURES.mixed;
  const out = {
    ...envelope(r),
    ...extra,
    summary: validMixed().summary,
    sections: [],
    tasks: [],
    ideas: [],
    people: [],
    projects: [],
  };
  const filler = i =>
    `Item ${String(i).padStart(
      3,
      '0',
    )} ${'with a longer explanatory sentence about the source. '.repeat(
      5,
    )}`.trim();
  const sources = [
    ref(r, 0, 0),
    ref(r, 0, 1),
    ref(r, 1, 0),
    ref(r, 2, 0),
    ref(r, 2, 1),
    ref(r, 3, 0),
  ];
  for (let i = 0; ; i += 1) {
    const list = i % 2 ? 'ideas' : 'tasks';
    if (out[list].length >= 50) break;
    out[list].push(
      list === 'tasks'
        ? { text: filler(i), area: 'work', sources }
        : { text: filler(i), sources },
    );
    if (bytes(out) > OUTPUT_CAP) {
      out[list].pop();
      break;
    }
  }
  return out;
}

/** Pads items (up to 400 code units each) so the canonical output is exactly `target` bytes. */
function sizeOutputTo(out, target) {
  const items = [...out.tasks, ...out.ideas];
  for (const item of items) {
    const diff = target - bytes(out);
    if (diff <= 0) break;
    item.text += 'y'.repeat(Math.min(diff, 400 - item.text.length));
  }
  const last = items[items.length - 1];
  for (let guard = 0; guard < 1000; guard += 1) {
    const diff = target - bytes(out);
    if (diff === 0) return out;
    if (diff > 0) throw new Error('output cap not reachable');
    last.text = last.text.slice(0, diff);
  }
  throw new Error('could not size the output');
}

// ---------------------------------------------------------------- result cases

const resultCases = [];
function valid(name, fixture, result) {
  resultCases.push({ name, fixture, result, expect: { valid: true } });
}
function invalid(name, fixture, code, result) {
  resultCases.push({
    name,
    fixture,
    ...result,
    expect: { valid: false, code },
  });
}
for (const [name, build] of Object.entries(VALID)) {
  const fixture =
    name === 'emptyLists'
      ? 'corrected'
      : ['maxOutput', 'maxOutputPartial', 'partial'].includes(name)
      ? 'mixed'
      : name;
  valid(`valid-${name}`, fixture, build());
}

/** An invalid variant of the valid mixed result. */
function mutate(name, code, change) {
  const result = validMixed();
  change(result);
  invalid(name, 'mixed', code, { result });
}
const firstTaskRef = r => r.tasks[0].sources[0];
const voiceTaskRef = r => r.tasks[1].sources[0];

// 1. Size
mutate('size-over-limit', 'RESULT_SIZE', r => {
  // Fifty long ideas, each citing six units: well over the output cap.
  const m = FIXTURES.mixed;
  const sources = [
    ref(m, 0, 0),
    ref(m, 0, 1),
    ref(m, 1, 0),
    ref(m, 2, 0),
    ref(m, 2, 1),
    ref(m, 3, 0),
  ];
  r.ideas = Array.from({ length: 50 }, (_, i) => ({
    text: `Idea ${i} ${'x'.repeat(390)}`,
    sources,
  }));
});
mutate('depth-over-limit', 'RESULT_SIZE', r => {
  r.engine.extra = { a: { b: { c: { d: { e: { f: {} } } } } } };
});
// 2. Schema
mutate('missing-engine', 'RESULT_SCHEMA', r => delete r.engine);
mutate('unknown-top-field', 'RESULT_SCHEMA', r => {
  r.debug = 'trace';
});
mutate('unknown-ref-field', 'RESULT_SCHEMA', r => {
  firstTaskRef(r).note = 'x';
});
mutate('prototype-key', 'RESULT_SCHEMA', r => {
  Object.defineProperty(r.tasks[0], '__proto__', {
    value: { admin: true },
    enumerable: true,
  });
});
mutate('constructor-key', 'RESULT_SCHEMA', r => {
  r.ideas[0].constructor = 'x';
});
mutate('wrong-contract', 'RESULT_SCHEMA', r => {
  r.contract = 'journal.organize@2';
});
mutate('bad-area', 'RESULT_SCHEMA', r => {
  r.tasks[0].area = 'urgent';
});
mutate('empty-sources', 'RESULT_SCHEMA', r => {
  r.ideas[0].sources = [];
});
mutate('nine-sources', 'RESULT_SCHEMA', r => {
  const s = r.tasks[0].sources[0];
  r.tasks[0].sources = Array.from({ length: 9 }, (_, i) => ({
    ...s,
    charStart: i,
    charEnd: i + 1,
  }));
});
mutate('fifty-one-tasks', 'RESULT_SCHEMA', r => {
  r.tasks = Array.from({ length: 51 }, (_, i) => ({
    text: `Task ${i}`,
    area: 'work',
    sources: [firstTaskRef(r)],
  }));
});
mutate('text-over-limit-utf16', 'RESULT_SCHEMA', r => {
  r.ideas[0].text = '😀'.repeat(201);
});
mutate('fraction-offset', 'RESULT_SCHEMA', r => {
  firstTaskRef(r).charStart = 1.5;
});
mutate('string-offset', 'RESULT_SCHEMA', r => {
  firstTaskRef(r).charEnd = '40';
});
mutate('null-text', 'RESULT_SCHEMA', r => {
  r.ideas[0].text = null;
});
mutate('bad-rule', 'RESULT_SCHEMA', r => {
  r.tasks[0].rule = 'Task Need To';
});
mutate('empty-section', 'RESULT_SCHEMA', r => {
  r.sections[1].items = [];
});
const dupKey = canonical(validMixed()).replace(
  '"contract":',
  '"contract":"journal.organize@1","contract":',
);
invalid('duplicate-key', 'mixed', 'RESULT_SCHEMA', { resultText: dupKey });
invalid('trailing-data', 'mixed', 'RESULT_SCHEMA', {
  resultText: `${canonical(validMixed())} {}`,
});
invalid('invalid-utf8', 'mixed', 'RESULT_SCHEMA', {
  resultBase64: Buffer.concat([
    Buffer.from(canonical(validMixed()).slice(0, -1)),
    Buffer.from([0xff, 0x7d]),
  ]).toString('base64'),
});
// 3. Echo
mutate('request-key-mismatch', 'RESULT_ECHO', r => {
  r.requestKey = id('org', 77);
});
mutate('input-digest-mismatch', 'RESULT_ECHO', r => {
  r.inputSha256 = sha256('another input');
});
// 4. Kinds
mutate('kind-missing', 'RESULT_KINDS', r => delete r.people);
invalid('kind-not-requested', 'summaryOnly', 'RESULT_KINDS', {
  result: { ...VALID.summaryOnly(), tasks: [] },
});
mutate('sections-out-of-order', 'RESULT_KINDS', r => r.sections.reverse());
mutate('sections-duplicate-area', 'RESULT_KINDS', r => {
  r.sections[1].area = 'work';
});
// 5. Completeness (amendment A1, §3.2)
mutate('completeness-missing', 'RESULT_SCHEMA', r => {
  delete r.completeness;
});
mutate('completeness-unknown', 'RESULT_SCHEMA', r => {
  r.completeness = 'truncated';
});
mutate('omitted-empty', 'RESULT_SCHEMA', r => {
  r.completeness = 'partial';
  r.omitted = {};
});
mutate('omitted-zero', 'RESULT_SCHEMA', r => {
  r.completeness = 'partial';
  r.omitted = { tasks: 0 };
});
mutate('omitted-summary', 'RESULT_SCHEMA', r => {
  r.completeness = 'partial';
  r.omitted = { summary: 1 };
});
mutate('partial-without-omitted', 'RESULT_COMPLETENESS', r => {
  r.completeness = 'partial';
});
mutate('omitted-on-complete', 'RESULT_COMPLETENESS', r => {
  r.omitted = { tasks: 1 };
});
mutate('completeness-before-text', 'RESULT_COMPLETENESS', r => {
  r.completeness = 'partial';
  r.tasks[0].text = '   ';
});
invalid('omitted-unrequested-kind', 'summaryOnly', 'RESULT_COMPLETENESS', {
  result: {
    ...VALID.summaryOnly(),
    completeness: 'partial',
    omitted: { tasks: 1 },
  },
});
// 6. Text
mutate('bidi-override', 'RESULT_TEXT', r => {
  r.ideas[0].text = 'Reading club ‮gnirps';
});
mutate('bidi-isolate', 'RESULT_TEXT', r => {
  r.people[0].name = 'Pri⁦ya';
});
mutate('newline-in-text', 'RESULT_TEXT', r => {
  r.tasks[0].text = 'Send the budget\nto Priya.';
});
mutate('control-character', 'RESULT_TEXT', r => {
  r.summary.text = 'Report \u0007 ready.';
});
mutate('c1-control', 'RESULT_TEXT', r => {
  r.summary.text = 'Report \u0085 ready.';
});
mutate('line-separator', 'RESULT_TEXT', r => {
  r.summary.text = 'Report ready.';
});
mutate('blank-text', 'RESULT_TEXT', r => {
  r.ideas[1].text = '　  ';
});
invalid('lone-surrogate', 'mixed', 'RESULT_TEXT', {
  resultText: canonical(validMixed()).replace(
    'A weekend reading club',
    'A weekend \\ud800 club',
  ),
});
// 7. Reference
mutate('fabricated-entry', 'RESULT_REFERENCE', r => {
  firstTaskRef(r).entryId = id('ent', 4040);
});
mutate('fabricated-unit', 'RESULT_REFERENCE', r => {
  firstTaskRef(r).unitId = 'w9';
});
mutate('unit-of-other-entry', 'RESULT_REFERENCE', r => {
  voiceTaskRef(r).unitId = FIXTURES.mixed.entries[3].units[0].unitId;
});
mutate('superseded-segment', 'RESULT_REFERENCE', r => {
  // The original engine row of the corrected line is not in the request.
  r.projects[0].sources[0] = {
    ...ref(FIXTURES.mixed, 3, 1),
    unitId: id('seg', 401),
  };
});
// 8. Digest
mutate('digest-mismatch', 'RESULT_DIGEST', r => {
  firstTaskRef(r).unitSha256 = sha256('stale text');
});
mutate('digest-of-other-unit', 'RESULT_DIGEST', r => {
  voiceTaskRef(r).unitSha256 = FIXTURES.mixed.entries[2].units[0].sha256;
});
// 9. Range
mutate('range-past-end', 'RESULT_RANGE', r => {
  firstTaskRef(r).charEnd = 4000;
});
mutate('range-reversed', 'RESULT_RANGE', r => {
  const s = firstTaskRef(r);
  [s.charStart, s.charEnd] = [s.charEnd, s.charStart];
});
mutate('range-zero-length', 'RESULT_RANGE', r => {
  const s = firstTaskRef(r);
  s.charEnd = s.charStart;
});
mutate('voice-without-audio', 'RESULT_RANGE', r => {
  delete voiceTaskRef(r).audioStartMs;
  delete voiceTaskRef(r).audioEndMs;
});
mutate('voice-half-audio', 'RESULT_RANGE', r => {
  delete voiceTaskRef(r).audioEndMs;
});
mutate('written-with-audio', 'RESULT_RANGE', r => {
  Object.assign(firstTaskRef(r), { audioStartMs: 0, audioEndMs: 1000 });
});
mutate('audio-outside-segment', 'RESULT_RANGE', r => {
  voiceTaskRef(r).audioEndMs += 1;
});
mutate('audio-before-segment', 'RESULT_RANGE', r => {
  voiceTaskRef(r).audioStartMs -= 1;
});
mutate('audio-reversed', 'RESULT_RANGE', r => {
  const s = voiceTaskRef(r);
  [s.audioStartMs, s.audioEndMs] = [s.audioEndMs, s.audioStartMs];
});
mutate('audio-zero-length', 'RESULT_RANGE', r => {
  const s = voiceTaskRef(r);
  s.audioEndMs = s.audioStartMs;
});
invalid('range-splits-surrogate', 'unicode', 'RESULT_RANGE', {
  result: (() => {
    const r = VALID.unicode();
    r.summary.sources[0].charEnd -= 1; // ends between the two halves of 😀
    return r;
  })(),
});
// 10. Order
mutate('refs-out-of-order', 'RESULT_ORDER', r => r.summary.sources.reverse());
mutate('refs-duplicate', 'RESULT_ORDER', r => {
  r.ideas[0].sources.push({ ...r.ideas[0].sources[0] });
});
mutate('refs-overlapping', 'RESULT_ORDER', r => {
  const s = r.ideas[0].sources[0];
  r.ideas[0].sources = [
    { ...s, charEnd: 20 },
    { ...s, charStart: 10, charEnd: 30 },
  ];
});
// 11. Duplicate
mutate('duplicate-task', 'RESULT_DUPLICATE', r => {
  r.tasks.push({
    ...clone(r.tasks[0]),
    text: '  send the REVISED budget to Priya by Friday. ',
  });
});
mutate('duplicate-person-nfc', 'RESULT_DUPLICATE', r => {
  r.people.push({ name: 'Arjun', sources: r.people[1].sources });
});
mutate('duplicate-section-item', 'RESULT_DUPLICATE', r => {
  r.sections[0].items.push({ ...clone(r.sections[0].items[0]) });
});
// Ordering of rules: the first failing rule wins.
mutate('first-rule-wins', 'RESULT_ECHO', r => {
  r.requestKey = id('org', 78);
  firstTaskRef(r).unitSha256 = sha256('x');
});

// ---------------------------------------------------------------- input cases

const inputCases = [];
for (const [name, req] of Object.entries(FIXTURES)) {
  inputCases.push({
    name: `valid-${name}`,
    input: req,
    expect: { valid: true },
  });
}
function inputMutate(name, code, change, base = FIXTURES.mixed) {
  const input = clone(base);
  change(input);
  inputCases.push({ name, input, expect: { valid: false, code } });
}
const rehash = unit => {
  unit.sha256 = sha256(unit.text);
};
inputMutate(
  'over-size',
  'INPUT_SIZE',
  i => {
    i.entries[0].units[0].text += ' extra words to pass the limit'.repeat(40);
    rehash(i.entries[0].units[0]);
  },
  FIXTURES.max,
);
inputMutate('depth-over-limit', 'INPUT_SIZE', i => {
  i.entries[0].units[0].extra = { a: { b: { c: { d: {} } } } };
});
inputMutate('no-entries', 'INPUT_SCHEMA', i => {
  i.entries = [];
});
inputMutate('no-units', 'INPUT_SCHEMA', i => {
  i.entries[0].units = [];
});
inputMutate('no-kinds', 'INPUT_SCHEMA', i => {
  i.kinds = [];
});
inputMutate('duplicate-kind', 'INPUT_SCHEMA', i => {
  i.kinds = ['tasks', 'tasks'];
});
inputMutate('unknown-kind', 'INPUT_SCHEMA', i => {
  i.kinds = ['tasks', 'topics'];
});
inputMutate('unknown-field', 'INPUT_SCHEMA', i => {
  i.audio = 'base64';
});
inputMutate('prototype-key', 'INPUT_SCHEMA', i => {
  Object.defineProperty(i.entries[0], '__proto__', {
    value: {},
    enumerable: true,
  });
});
inputMutate('bad-request-key', 'INPUT_SCHEMA', i => {
  i.requestKey = 'org_UPPERCASE00000000000000000';
});
inputMutate('voice-without-recording', 'INPUT_SCHEMA', i => {
  delete i.entries[2].recordingId;
});
inputMutate('written-with-recording', 'INPUT_SCHEMA', i => {
  i.entries[0].recordingId = id('rec', 1);
});
inputMutate('twenty-one-entries', 'INPUT_SCHEMA', i => {
  i.entries = Array.from({ length: 21 }, (_, k) => ({
    ...clone(W1),
    entryId: id('ent', 500 + k),
    createdAt: `2026-10-01T01:${String(k).padStart(2, '0')}:00.000Z`,
  }));
});
inputMutate('four-hundred-one-units', 'INPUT_SCHEMA', i => {
  // Small units, so the unit count, not the size, is what fails.
  i.entries = [i.entries[0]];
  i.entries[0].units = Array.from({ length: 401 }, (_, k) => {
    const text = `N${k}.`;
    return { unitId: `w${k}`, text, sha256: sha256(text), offset: k * 8 };
  });
});
inputMutate('unit-over-limit-utf16', 'INPUT_SCHEMA', i => {
  const unit = i.entries[0].units[0];
  unit.text = '😀'.repeat(2001);
  rehash(unit);
});
inputMutate('bidi-in-text', 'INPUT_TEXT', i => {
  const u = i.entries[0].units[0];
  u.text = `Report ‮ review`;
  rehash(u);
});
inputMutate('blank-text', 'INPUT_TEXT', i => {
  const u = i.entries[0].units[0];
  u.text = '  ';
  rehash(u);
});
inputMutate('newline-in-voice', 'INPUT_TEXT', i => {
  const u = i.entries[2].units[0];
  u.text = 'Stand-up\nnotes.';
  rehash(u);
});
inputMutate('digest-mismatch', 'INPUT_DIGEST', i => {
  i.entries[0].units[0].sha256 = sha256('other');
});
inputMutate('duplicate-entry', 'INPUT_DUPLICATE', i => {
  i.entries[1] = { ...clone(i.entries[0]) };
});
inputMutate('duplicate-unit', 'INPUT_DUPLICATE', i => {
  i.entries[2].units[1].unitId = i.entries[2].units[0].unitId;
});
inputMutate('end-past-duration', 'INPUT_RANGE', i => {
  i.entries[2].units[3].endMs = i.entries[2].durationMs + 1;
});
inputMutate('zero-length-segment', 'INPUT_RANGE', i => {
  const u = i.entries[2].units[1];
  u.endMs = u.startMs;
});
inputMutate('written-past-limit', 'INPUT_RANGE', i => {
  i.entries[0].units[2].offset = 199_990;
});
inputMutate('entries-out-of-order', 'INPUT_ORDER', i => i.entries.reverse());
inputMutate('voice-units-out-of-order', 'INPUT_ORDER', i => {
  const u = i.entries[2].units;
  [u[0], u[1]] = [u[1], u[0]];
});
inputMutate('written-units-overlap', 'INPUT_ORDER', i => {
  i.entries[0].units[1].offset = 10;
});
const rawInput = canonical(FIXTURES.mixed);
inputCases.push({
  name: 'duplicate-key',
  inputText: rawInput.replace('"locale":', '"locale":"en-IN","locale":'),
  expect: { valid: false, code: 'INPUT_SCHEMA' },
});
inputCases.push({
  name: 'lone-surrogate',
  inputText: rawInput.replace('Quarterly report', 'Quarterly \\udc00report'),
  expect: { valid: false, code: 'INPUT_TEXT' },
});

// ---------------------------------------------------------------- boundaries

/** One byte over a cap: the last unit gains one ASCII character. */
const overInput = sizeInputTo(clone(FIXTURES.max), INPUT_CAP + 1);
inputCases.push({
  name: 'over-cap-by-one',
  input: overInput,
  expect: { valid: false, code: 'INPUT_SIZE' },
});
const atOutputCap = VALID.maxOutput();
const overOutput = sizeOutputTo(clone(atOutputCap), OUTPUT_CAP + 1);
invalid('over-cap-by-one', 'mixed', 'RESULT_SIZE', { result: overOutput });

// Whole messages with their protocol envelopes (contract §8.1).
const MAX_ENVELOPE = {
  requestId: 'r'.repeat(64),
  idempotencyKey: 'k'.repeat(128),
  version: '99.99.99',
  deadlineMs: 120_000,
  stream: false,
};
const jobRequest = (input, e) => ({
  capability: { id: 'journal.organize', version: e.version },
  deadlineMs: e.deadlineMs,
  idempotencyKey: e.idempotencyKey,
  input,
  requestId: e.requestId,
  stream: e.stream,
});
const completedEvent = (output, sequence) => ({
  data: { output },
  sequence,
  type: 'completed',
});
const envelopeCases = [
  {
    name: 'request-at-cap',
    kind: 'jobRequest',
    input: 'fixture:max',
    envelope: MAX_ENVELOPE,
    expect: {
      bytes: bytes(jobRequest(FIXTURES.max, MAX_ENVELOPE)),
      withinCap: true,
    },
  },
  {
    name: 'request-over-cap',
    kind: 'jobRequest',
    input: 'input:over-cap-by-one',
    envelope: MAX_ENVELOPE,
    expect: {
      bytes: bytes(jobRequest(overInput, MAX_ENVELOPE)),
      withinCap: false,
    },
  },
  {
    name: 'event-at-cap',
    kind: 'completedEvent',
    output: 'result:valid-maxOutput',
    sequence: 64,
    expect: { bytes: bytes(completedEvent(atOutputCap, 64)), withinCap: true },
  },
  {
    name: 'event-over-cap',
    kind: 'completedEvent',
    output: 'result:over-cap-by-one',
    sequence: 64,
    expect: { bytes: bytes(completedEvent(overOutput, 64)), withinCap: false },
  },
];
for (const c of envelopeCases) {
  if (c.expect.bytes <= MESSAGE_CAP !== c.expect.withinCap)
    throw new Error(`budget ${c.name}`);
}
if (
  envelopeCases[0].expect.bytes !== MESSAGE_CAP ||
  envelopeCases[2].expect.bytes !== MESSAGE_CAP
) {
  throw new Error('the at-cap messages must be exactly 61,440 bytes');
}

// Request keys (contract §9): same request, same key; any change, a new key.
const keyCase = (name, input, note) => ({
  name,
  input,
  note,
  expect: { requestKey: requestKey(TEST_KEY, input) },
});
const changed = change => {
  const input = clone(FIXTURES.mixed);
  change(input);
  return input;
};
const requestKeyCases = [
  keyCase('mixed', FIXTURES.mixed, 'the fixture'),
  keyCase(
    'identical-copy',
    clone(FIXTURES.mixed),
    'an identical request reuses the key',
  ),
  keyCase(
    'stale-key-ignored',
    changed(i => {
      i.requestKey = id('org', 5);
    }),
    'the key is computed without the requestKey member',
  ),
  keyCase(
    'kinds-changed',
    changed(i => {
      i.kinds = ['tasks'];
    }),
    'different kinds, different key',
  ),
  keyCase(
    'text-changed',
    changed(i => {
      const u = i.entries[0].units[0];
      u.text += ' ';
      u.sha256 = sha256(u.text);
    }),
    'one character more, different key',
  ),
  keyCase(
    'time-zone-changed',
    changed(i => {
      i.timeZone = 'UTC';
    }),
    'context change, different key',
  ),
  keyCase(
    'entry-removed',
    changed(i => {
      i.entries.pop();
    }),
    'smaller selection, different key',
  ),
];
if (
  requestKeyCases[0].expect.requestKey !==
    requestKeyCases[1].expect.requestKey ||
  requestKeyCases[0].expect.requestKey !== requestKeyCases[2].expect.requestKey
) {
  throw new Error('identical requests must share a key');
}
if (
  new Set(requestKeyCases.map(c => c.expect.requestKey)).size !==
  requestKeyCases.length - 2
) {
  throw new Error('changed requests must get new keys');
}

// ---------------------------------------------------------------- event cases

// App handling of one run's updates (contract §4). Results are named:
// results are named by their result case.
// Unless a case names another fixture, events belong to the mixed request.
const eventCases = [
  {
    name: 'progress-partial-completed',
    events: [
      { type: 'accepted' },
      { type: 'progress', stage: 'received', fraction: 0.1 },
      { type: 'partial', delta: { counts: { tasks: 2 } } },
      { type: 'progress', stage: 'checking', fraction: 0.9 },
      { type: 'completed', result: 'valid-mixed' },
    ],
    expect: { outcome: 'stored', partials: 1 },
  },
  {
    name: 'partial-then-failed',
    events: [
      { type: 'accepted' },
      { type: 'partial', delta: { counts: { tasks: 1 } } },
      { type: 'failed', code: 'EXECUTION_FAILED' },
    ],
    expect: { outcome: 'failed', code: 'EXECUTION_FAILED', partials: 1 },
  },
  {
    name: 'deadline',
    events: [
      { type: 'accepted' },
      { type: 'progress', stage: 'extracting' },
      { type: 'failed', code: 'DEADLINE_EXCEEDED' },
    ],
    expect: { outcome: 'failed', code: 'DEADLINE_EXCEEDED', partials: 0 },
  },
  {
    name: 'cancelled',
    events: [
      { type: 'accepted' },
      { type: 'partial', delta: { counts: { ideas: 1 } } },
      { type: 'cancelled' },
    ],
    expect: { outcome: 'cancelled', partials: 1 },
  },
  {
    name: 'invalid-result',
    events: [
      { type: 'accepted' },
      { type: 'completed', result: 'request-key-mismatch' },
    ],
    expect: {
      outcome: 'invalid',
      code: 'INVALID_RESULT',
      subCode: 'RESULT_ECHO',
      partials: 0,
    },
  },
  {
    name: 'after-terminal-ignored',
    events: [
      { type: 'accepted' },
      { type: 'completed', result: 'valid-mixed' },
      { type: 'progress', stage: 'checking' },
      { type: 'failed', code: 'EXECUTION_FAILED' },
    ],
    expect: { outcome: 'stored', partials: 0 },
  },
  {
    name: 'second-completed-ignored',
    events: [
      { type: 'accepted' },
      { type: 'completed', result: 'valid-mixed' },
      { type: 'completed', result: 'valid-mixed' },
    ],
    expect: { outcome: 'stored', partials: 0 },
  },
  {
    name: 'failed-then-completed-ignored',
    events: [
      { type: 'accepted' },
      { type: 'failed', code: 'EXECUTION_FAILED' },
      { type: 'completed', result: 'valid-mixed' },
    ],
    expect: { outcome: 'failed', code: 'EXECUTION_FAILED', partials: 0 },
  },
  {
    name: 'no-terminal',
    events: [{ type: 'accepted' }, { type: 'progress', stage: 'received' }],
    expect: { outcome: 'failed', code: 'EXECUTION_FAILED', partials: 0 },
  },
  {
    name: 'invalid-partial-ignored',
    events: [
      { type: 'accepted' },
      { type: 'partial', delta: { counts: { topics: 3 } } },
      { type: 'partial', delta: { text: 'leak' } },
      { type: 'partial', delta: { counts: {} } },
      { type: 'completed', result: 'valid-mixed' },
    ],
    expect: { outcome: 'stored', partials: 0, ignoredPartials: 3 },
  },
  {
    name: 'unrequested-kind-partial-ignored',
    fixture: 'summaryOnly',
    events: [
      { type: 'accepted' },
      { type: 'partial', delta: { counts: { tasks: 1 } } },
      { type: 'partial', delta: { counts: { summary: 1 } } },
      { type: 'completed', result: 'valid-summaryOnly' },
    ],
    expect: { outcome: 'stored', partials: 1, ignoredPartials: 1 },
  },
  {
    name: 'replayed-request-key',
    alreadyStored: true,
    events: [
      { type: 'accepted' },
      { type: 'completed', result: 'valid-mixed' },
    ],
    expect: { outcome: 'duplicate', partials: 0 },
  },
];

// ---------------------------------------------------------------- write

const files = {
  'organize-input.schema.json': pretty(inputSchema),
  'organize-output.schema.json': pretty(outputSchema),
  'organize-partial.schema.json': pretty(partialSchema),
  'vectors/fixtures.json': pretty(FIXTURES),
  'vectors/inputs.json': pretty(inputCases),
  'vectors/results.json': pretty(resultCases),
  'vectors/events.json': pretty(eventCases),
  'vectors/envelopes.json': pretty(envelopeCases),
  'vectors/request-keys.json': pretty({
    testKeyHex: TEST_KEY.toString('hex'),
    cases: requestKeyCases,
  }),
};
const manifest = {
  contract: 'journal.organize@1',
  generator: 'tools/journal-organize/generate-vectors.mjs',
  files: Object.fromEntries(
    Object.entries(files).map(([name, text]) => [name, sha256(text)]),
  ),
  budget: {
    messageCap: MESSAGE_CAP,
    requestEnvelopeMax: REQUEST_ENVELOPE_MAX,
    eventEnvelope: EVENT_ENVELOPE,
    inputCap: INPUT_CAP,
    outputCap: OUTPUT_CAP,
  },
  counts: {
    fixtures: Object.keys(FIXTURES).length,
    inputs: inputCases.length,
    inputsValid: inputCases.filter(c => c.expect.valid).length,
    results: resultCases.length,
    resultsValid: resultCases.filter(c => c.expect.valid).length,
    events: eventCases.length,
    envelopes: envelopeCases.length,
    requestKeys: requestKeyCases.length,
  },
};
files['vectors.json'] = pretty(manifest);

let mismatches = 0;
for (const [name, text] of Object.entries(files)) {
  const path = join(OUT, name);
  if (CHECK) {
    let current = '';
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      // missing
    }
    if (current !== text) {
      mismatches += 1;
      process.stdout.write(`MISMATCH ${name}\n`);
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}
const c = manifest.counts;
process.stdout.write(
  `${CHECK ? 'checked' : 'wrote'} ${Object.keys(files).length} files: ` +
    `${c.fixtures} fixtures, ${c.inputs} input cases (${c.inputsValid} valid), ` +
    `${c.results} result cases (${c.resultsValid} valid), ${c.events} event cases, ` +
    `${c.envelopes} envelope cases, ${c.requestKeys} request-key cases` +
    `${CHECK ? `, ${mismatches} mismatches` : ''}\n`,
);
if (CHECK && mismatches > 0) process.exitCode = 1;
