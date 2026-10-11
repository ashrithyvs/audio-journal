// journal.organize@1 validation (docs/journal-organize.md §6, §6.1), the
// companion's own implementation. It checks every request before the engine
// sees it and every result before it leaves the node. The schemas are the
// pinned files in ../contract, byte-identical to schemas/journal/v1.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  byteLength,
  canonical,
  depthOf,
  JsonError,
  own,
  parseStrict,
} from './json.mjs';

const CONTRACT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'contract',
);
const load = name => JSON.parse(readFileSync(join(CONTRACT_DIR, name), 'utf8'));

export const SCHEMAS = {
  input: load('organize-input.schema.json'),
  output: load('organize-output.schema.json'),
  partial: load('organize-partial.schema.json'),
};

export const KINDS = [
  'summary',
  'sections',
  'tasks',
  'ideas',
  'people',
  'projects',
];
const LISTS = ['tasks', 'ideas', 'people', 'projects'];
export const MESSAGE_CAP = 61_440;
export const INPUT_CAP = 61_108;
export const OUTPUT_CAP = 61_387;
const MAX_DEPTH = 8;

export class ContractError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const reject = code => {
  throw new ContractError(code);
};

export const sha256 = text =>
  createHash('sha256').update(text, 'utf8').digest('hex');

// ------------------------------------------------------------- Draft 7 subset

const isInt = v => typeof v === 'number' && Number.isInteger(v);

/** The keywords the pinned schemas use; string lengths in UTF-16 units. */
export function matches(schema, v) {
  if (own(schema, 'const') && v !== schema.const) return false;
  if (own(schema, 'enum') && !schema.enum.includes(v)) return false;
  if (
    own(schema, 'oneOf') &&
    schema.oneOf.filter(s => matches(s, v)).length !== 1
  )
    return false;
  switch (schema.type) {
    case 'object': {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
      if ((schema.required ?? []).some(k => !own(v, k))) return false;
      const props = schema.properties ?? {};
      const keys = Object.keys(v);
      if (
        schema.additionalProperties === false &&
        keys.some(k => !own(props, k))
      )
        return false;
      if (own(schema, 'minProperties') && keys.length < schema.minProperties)
        return false;
      return Object.keys(props).every(
        k => !own(v, k) || matches(props[k], v[k]),
      );
    }
    case 'array': {
      if (!Array.isArray(v)) return false;
      if (
        v.length < (schema.minItems ?? 0) ||
        v.length > (schema.maxItems ?? Infinity)
      )
        return false;
      if (schema.uniqueItems && new Set(v.map(canonical)).size !== v.length)
        return false;
      return !schema.items || v.every(x => matches(schema.items, x));
    }
    case 'string':
      if (typeof v !== 'string') return false;
      if (
        v.length < (schema.minLength ?? 0) ||
        v.length > (schema.maxLength ?? Infinity)
      )
        return false;
      return !schema.pattern || new RegExp(schema.pattern).test(v);
    case 'integer':
      return (
        isInt(v) &&
        v >= (schema.minimum ?? -Infinity) &&
        v <= (schema.maximum ?? Infinity)
      );
    case undefined:
      return true;
    default:
      throw new Error(`unsupported schema type ${schema.type}`);
  }
}

// ------------------------------------------------------------- text rules

function forbidden(code, allowLfTab) {
  if (allowLfTab && (code === 0x0a || code === 0x09)) return false;
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

const ZS = /\p{Zs}/u;
const ZS_RUN = /\p{Zs}+/gu;

/** Contract §6: well-formed, no forbidden characters, not blank. */
export function textOk(text, allowLfTab) {
  if (!text.isWellFormed()) return false;
  let blank = true;
  for (const ch of text) {
    if (forbidden(ch.codePointAt(0), allowLfTab)) return false;
    if (!ZS.test(ch)) blank = false;
  }
  return !blank;
}

export const normalized = text =>
  text
    .normalize('NFC')
    .toLowerCase()
    .replace(ZS_RUN, ' ')
    .replace(/^ +| +$/g, '');

function splitsPair(text, i) {
  if (i <= 0 || i >= text.length) return false;
  const hi = text.charCodeAt(i - 1);
  const lo = text.charCodeAt(i);
  return hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff;
}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------- input (§6.1)

/** Validates request input bytes or an already-parsed value; returns it. */
export function validateInput(raw) {
  let input = raw;
  if (typeof raw === 'string' || raw instanceof Uint8Array) {
    try {
      input = parseStrict(raw);
    } catch (error) {
      if (error instanceof JsonError) reject('INPUT_SCHEMA');
      throw error;
    }
  }
  if (byteLength(input) > INPUT_CAP || depthOf(input) > MAX_DEPTH)
    reject('INPUT_SIZE');
  if (!matches(SCHEMAS.input, input)) reject('INPUT_SCHEMA');
  if (input.entries.reduce((n, e) => n + e.units.length, 0) > 400)
    reject('INPUT_SCHEMA');
  for (const e of input.entries) {
    for (const u of e.units)
      if (!textOk(u.text, e.kind === 'written')) reject('INPUT_TEXT');
  }
  for (const e of input.entries) {
    for (const u of e.units)
      if (sha256(u.text) !== u.sha256) reject('INPUT_DIGEST');
  }
  if (new Set(input.entries.map(e => e.entryId)).size !== input.entries.length)
    reject('INPUT_DUPLICATE');
  for (const e of input.entries) {
    if (new Set(e.units.map(u => u.unitId)).size !== e.units.length)
      reject('INPUT_DUPLICATE');
  }
  for (const e of input.entries) {
    for (const u of e.units) {
      if (
        e.kind === 'voice'
          ? !(u.startMs < u.endMs && u.endMs <= e.durationMs)
          : u.offset + u.text.length > 200_000
      ) {
        reject('INPUT_RANGE');
      }
    }
  }
  for (let k = 1; k < input.entries.length; k += 1) {
    const a = input.entries[k - 1];
    const b = input.entries[k];
    const order =
      compare(a.createdAt, b.createdAt) || compare(a.entryId, b.entryId);
    if (order >= 0) reject('INPUT_ORDER');
  }
  for (const e of input.entries) {
    for (let k = 1; k < e.units.length; k += 1) {
      const a = e.units[k - 1];
      const b = e.units[k];
      if (
        e.kind === 'voice'
          ? b.startMs < a.startMs
          : a.offset + a.text.length > b.offset
      )
        reject('INPUT_ORDER');
    }
  }
  return input;
}

// ------------------------------------------------------------- result (§6)

function* itemsInOrder(out) {
  if (own(out, 'summary')) yield { item: out.summary, text: out.summary.text };
  for (const section of out.sections ?? []) {
    for (const item of section.items) yield { item, text: item.text };
  }
  for (const kind of LISTS) {
    for (const item of out[kind] ?? [])
      yield { item, text: own(item, 'text') ? item.text : item.name };
  }
}

/** Validates a result against its request; returns the sub-code or null. */
export function resultViolation(rawOrOutput, input) {
  try {
    validateOutput(rawOrOutput, input);
    return null;
  } catch (error) {
    if (error instanceof ContractError) return error.code;
    throw error;
  }
}

export function validateOutput(raw, input) {
  let out = raw;
  if (typeof raw === 'string' || raw instanceof Uint8Array) {
    try {
      out = parseStrict(raw);
    } catch (error) {
      if (error instanceof JsonError) reject('RESULT_SCHEMA');
      throw error;
    }
  }
  if (byteLength(out) > OUTPUT_CAP || depthOf(out) > MAX_DEPTH)
    reject('RESULT_SIZE');
  if (!matches(SCHEMAS.output, out)) reject('RESULT_SCHEMA');
  let refCount = 0;
  for (const { item } of itemsInOrder(out)) refCount += item.sources.length;
  if (refCount > 1000) reject('RESULT_SCHEMA');
  if (
    out.contract !== input.contract ||
    out.requestKey !== input.requestKey ||
    out.inputSha256 !== sha256(canonical(input))
  ) {
    reject('RESULT_ECHO');
  }
  const present = KINDS.filter(k => own(out, k));
  const requested = KINDS.filter(k => input.kinds.includes(k));
  if (present.join() !== requested.join()) reject('RESULT_KINDS');
  const areas = (out.sections ?? []).map(s => s.area).join();
  if (!['', 'work', 'personal', 'work,personal'].includes(areas))
    reject('RESULT_KINDS');
  for (const { text } of itemsInOrder(out))
    if (!textOk(text, false)) reject('RESULT_TEXT');

  const entries = new Map(
    input.entries.map((e, index) => [e.entryId, { e, index }]),
  );
  const unitOf = ref => {
    const found = entries.get(ref.entryId);
    if (!found) return null;
    const unitIndex = found.e.units.findIndex(u => u.unitId === ref.unitId);
    return unitIndex < 0
      ? null
      : { ...found, unitIndex, unit: found.e.units[unitIndex] };
  };
  const refs = [];
  for (const { item } of itemsInOrder(out))
    for (const ref of item.sources) refs.push(ref);
  for (const ref of refs) if (!unitOf(ref)) reject('RESULT_REFERENCE');
  for (const ref of refs)
    if (ref.unitSha256 !== unitOf(ref).unit.sha256) reject('RESULT_DIGEST');
  for (const ref of refs) {
    const { e, unit } = unitOf(ref);
    if (
      !(
        ref.charStart >= 0 &&
        ref.charStart < ref.charEnd &&
        ref.charEnd <= unit.text.length
      )
    )
      reject('RESULT_RANGE');
    if (
      splitsPair(unit.text, ref.charStart) ||
      splitsPair(unit.text, ref.charEnd)
    )
      reject('RESULT_RANGE');
    const hasA = own(ref, 'audioStartMs');
    const hasB = own(ref, 'audioEndMs');
    if (e.kind === 'voice') {
      if (!hasA || !hasB) reject('RESULT_RANGE');
      if (
        !(
          unit.startMs <= ref.audioStartMs &&
          ref.audioStartMs < ref.audioEndMs &&
          ref.audioEndMs <= unit.endMs
        )
      ) {
        reject('RESULT_RANGE');
      }
    } else if (hasA || hasB) {
      reject('RESULT_RANGE');
    }
  }
  for (const { item } of itemsInOrder(out)) {
    for (let k = 1; k < item.sources.length; k += 1) {
      const a = unitOf(item.sources[k - 1]);
      const b = unitOf(item.sources[k]);
      const ka = [a.index, a.unitIndex, item.sources[k - 1].charStart];
      const kb = [b.index, b.unitIndex, item.sources[k].charStart];
      const order =
        compare(ka[0], kb[0]) || compare(ka[1], kb[1]) || compare(ka[2], kb[2]);
      if (order >= 0) reject('RESULT_ORDER');
      if (
        ka[0] === kb[0] &&
        ka[1] === kb[1] &&
        item.sources[k - 1].charEnd > item.sources[k].charStart
      ) {
        reject('RESULT_ORDER');
      }
    }
  }
  const groups = [
    ...(out.sections ?? []).map(s => s.items.map(i => i.text)),
    ...LISTS.map(kind =>
      (out[kind] ?? []).map(i => (own(i, 'text') ? i.text : i.name)),
    ),
  ];
  for (const texts of groups) {
    const norm = texts.map(normalized);
    if (new Set(norm).size !== norm.length) reject('RESULT_DUPLICATE');
  }
  return out;
}

/** A streamed partial delta is valid for this request (contract §4). */
export function partialOk(delta, input) {
  return (
    matches(SCHEMAS.partial, delta) &&
    Object.keys(delta.counts).every(k => input.kinds.includes(k))
  );
}
