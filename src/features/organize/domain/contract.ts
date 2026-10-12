// journal.organize@1 (docs/journal-organize.md, ADR-019): the app's own
// validation of results before anything is stored (§6), checked against the
// pinned schemas in schemas/journal/v1 and every contract vector. Written for
// Hermes: no String.prototype.isWellFormed, and NFC only where the engine
// provides normalize().

import inputSchema from '../../../../schemas/journal/v1/organize-input.schema.json';
import outputSchema from '../../../../schemas/journal/v1/organize-output.schema.json';
import partialSchema from '../../../../schemas/journal/v1/organize-partial.schema.json';
import { deriveDue, type DueRule } from './dueDates';

export const CONTRACT = 'journal.organize@1';
export const CAPABILITY = { id: 'journal.organize', version: '1.0.0' } as const;
export const MESSAGE_CAP = 61_440;
export const INPUT_CAP = 61_108;
export const OUTPUT_CAP = 61_387;
export const ORGANIZE_TIMEOUT_MS = 60_000;
const MAX_DEPTH = 8;

export const KINDS = [
  'summary',
  'sections',
  'tasks',
  'ideas',
  'people',
  'projects',
] as const;
export type OrganizeKind = (typeof KINDS)[number];
const LISTS = ['tasks', 'ideas', 'people', 'projects'] as const;

export interface VoiceUnit {
  unitId: string;
  text: string;
  sha256: string;
  startMs: number;
  endMs: number;
}
export interface WrittenUnit {
  unitId: string;
  text: string;
  sha256: string;
  offset: number;
}
export type OrganizeEntry =
  | {
      entryId: string;
      kind: 'voice';
      createdAt: string;
      recordingId: string;
      transcriptRevision: number;
      durationMs: number;
      units: VoiceUnit[];
    }
  | {
      entryId: string;
      kind: 'written';
      createdAt: string;
      units: WrittenUnit[];
    };

export interface OrganizeInput {
  contract: typeof CONTRACT;
  requestKey: string;
  locale: string;
  timeZone: string;
  kinds: OrganizeKind[];
  entries: OrganizeEntry[];
}

export interface SourceRef {
  entryId: string;
  unitId: string;
  unitSha256: string;
  charStart: number;
  charEnd: number;
  audioStartMs?: number;
  audioEndMs?: number;
}
export interface OrganizeItem {
  text: string;
  rule?: string;
  sources: SourceRef[];
}
export interface DueDate {
  /** ISO calendar date, YYYY-MM-DD (contract §3.3). */
  date: string;
  rule: DueRule;
  /** The exact phrase the date comes from. */
  source: SourceRef;
}
export interface OrganizeTask extends OrganizeItem {
  area: 'work' | 'personal' | 'unsorted';
  due?: DueDate;
}
export interface NamedItem {
  name: string;
  rule?: string;
  sources: SourceRef[];
}
export interface OrganizeOutput {
  contract: typeof CONTRACT;
  requestKey: string;
  inputSha256: string;
  engine: { id: string; version: string };
  summary?: OrganizeItem;
  sections?: { area: 'work' | 'personal'; items: OrganizeItem[] }[];
  tasks?: OrganizeTask[];
  ideas?: OrganizeItem[];
  people?: NamedItem[];
  projects?: NamedItem[];
  /** Amendment A1 (§3.2): whether the result carries everything found. */
  completeness: 'complete' | 'partial';
  /** Per requested list kind, the lowest-ranked items left out. */
  omitted?: Partial<Record<Exclude<OrganizeKind, 'summary'>, number>>;
}

export type ResultCode =
  | 'RESULT_SIZE'
  | 'RESULT_SCHEMA'
  | 'RESULT_ECHO'
  | 'RESULT_KINDS'
  | 'RESULT_COMPLETENESS'
  | 'RESULT_TEXT'
  | 'RESULT_REFERENCE'
  | 'RESULT_DIGEST'
  | 'RESULT_RANGE'
  | 'RESULT_ORDER'
  | 'RESULT_DUE'
  | 'RESULT_DUPLICATE';

export const SCHEMAS = {
  input: inputSchema,
  output: outputSchema,
  partial: partialSchema,
};

// ------------------------------------------------------------- JSON

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const own = (o: unknown, k: string): boolean =>
  o !== null &&
  typeof o === 'object' &&
  Object.prototype.hasOwnProperty.call(o, k);

/** Contract §8 canonical JSON: sorted keys, compact. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** UTF-8 byte length without TextEncoder (Hermes). */
export function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i += 1;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

export const canonicalBytes = (value: unknown): number =>
  utf8Length(canonicalJson(value));

function depthOf(value: unknown): number {
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(depthOf));
  if (value !== null && typeof value === 'object') {
    return 1 + Math.max(0, ...Object.values(value as object).map(depthOf));
  }
  return 0;
}

/**
 * Strict parse for text that did not come through the SDK (tests, vectors):
 * JSON.parse silently keeps the last of duplicate keys, so the key tokens in
 * the text are counted and compared with the keys of the parsed value.
 * Returns null when the text is not acceptable.
 */
export function parseStrictJson(text: string): Json | null {
  let parsed: Json;
  try {
    parsed = JSON.parse(text) as Json;
  } catch {
    return null;
  }
  let keysInText = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (!inString) {
      if (c === '"') inString = true;
      continue;
    }
    if (c === '\\') {
      i += 1;
    } else if (c === '"') {
      inString = false;
      let j = i + 1;
      while (j < text.length && ' \t\r\n'.includes(text[j])) j += 1;
      if (text[j] === ':') keysInText += 1;
    }
  }
  let keysParsed = 0;
  const count = (v: Json): void => {
    if (Array.isArray(v)) v.forEach(count);
    else if (v !== null && typeof v === 'object') {
      keysParsed += Object.keys(v).length;
      Object.values(v).forEach(count);
    }
  };
  count(parsed);
  return keysParsed === keysInText ? parsed : null;
}

// ------------------------------------------------------------- Draft 7 subset

type Schema = Record<string, unknown>;

export function matchesSchema(schema: Schema, v: unknown): boolean {
  if (own(schema, 'const') && v !== schema.const) return false;
  if (own(schema, 'enum') && !(schema.enum as unknown[]).includes(v))
    return false;
  if (
    own(schema, 'oneOf') &&
    (schema.oneOf as Schema[]).filter(s => matchesSchema(s, v)).length !== 1
  )
    return false;
  switch (schema.type) {
    case 'object': {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
      const o = v as Record<string, unknown>;
      if (((schema.required as string[]) ?? []).some(k => !own(o, k)))
        return false;
      const props = (schema.properties as Record<string, Schema>) ?? {};
      const keys = Object.keys(o);
      if (
        schema.additionalProperties === false &&
        keys.some(k => !own(props, k))
      )
        return false;
      if (
        own(schema, 'minProperties') &&
        keys.length < (schema.minProperties as number)
      )
        return false;
      return Object.keys(props).every(
        k => !own(o, k) || matchesSchema(props[k], o[k]),
      );
    }
    case 'array': {
      if (!Array.isArray(v)) return false;
      if (
        v.length < ((schema.minItems as number) ?? 0) ||
        v.length > ((schema.maxItems as number) ?? Infinity)
      )
        return false;
      if (schema.uniqueItems && new Set(v.map(canonicalJson)).size !== v.length)
        return false;
      return (
        !schema.items || v.every(x => matchesSchema(schema.items as Schema, x))
      );
    }
    case 'string':
      if (typeof v !== 'string') return false;
      if (
        v.length < ((schema.minLength as number) ?? 0) ||
        v.length > ((schema.maxLength as number) ?? Infinity)
      )
        return false;
      return !schema.pattern || new RegExp(schema.pattern as string).test(v);
    case 'integer':
      return (
        typeof v === 'number' &&
        Number.isInteger(v) &&
        v >= ((schema.minimum as number) ?? -Infinity) &&
        v <= ((schema.maximum as number) ?? Infinity)
      );
    case undefined:
      return true;
    default:
      return false;
  }
}

// ------------------------------------------------------------- text rules

export function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = text.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

const ZS = /\p{Zs}/u;
const ZS_RUN = /\p{Zs}+/gu;

function forbidden(code: number, allowLfTab: boolean): boolean {
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

/** Contract §6: well-formed, no forbidden characters, not blank. */
export function textOk(text: string, allowLfTab = false): boolean {
  if (!wellFormed(text)) return false;
  let blank = true;
  for (const ch of text) {
    if (forbidden(ch.codePointAt(0) ?? 0, allowLfTab)) return false;
    if (!ZS.test(ch)) blank = false;
  }
  return !blank;
}

export function normalizedText(text: string): string {
  const nfc =
    typeof text.normalize === 'function' ? text.normalize('NFC') : text;
  return nfc
    .toLowerCase()
    .replace(ZS_RUN, ' ')
    .replace(/^ +| +$/g, '');
}

function splitsPair(text: string, i: number): boolean {
  if (i <= 0 || i >= text.length) return false;
  const hi = text.charCodeAt(i - 1);
  const lo = text.charCodeAt(i);
  return hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff;
}

// ------------------------------------------------------------- results (§6)

interface ItemView {
  item: { sources: SourceRef[] };
  text: string;
}

function itemsInOrder(out: OrganizeOutput): ItemView[] {
  const items: ItemView[] = [];
  if (out.summary) items.push({ item: out.summary, text: out.summary.text });
  for (const s of out.sections ?? [])
    for (const i of s.items) items.push({ item: i, text: i.text });
  for (const k of LISTS) {
    for (const i of (out[k] ?? []) as (OrganizeItem | NamedItem)[]) {
      items.push({ item: i, text: 'text' in i ? i.text : i.name });
    }
  }
  return items;
}

const cmp = (a: number | string, b: number | string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * Validates a completed output for its request (contract §6, in order).
 * `inputSha256` is the request's digest. Returns null when valid.
 */
export function resultViolation(
  output: unknown,
  input: OrganizeInput,
  inputSha256: string,
): ResultCode | null {
  if (canonicalBytes(output) > OUTPUT_CAP || depthOf(output) > MAX_DEPTH)
    return 'RESULT_SIZE';
  if (!matchesSchema(outputSchema as Schema, output)) return 'RESULT_SCHEMA';
  const out = output as OrganizeOutput;
  const items = itemsInOrder(out);
  const dues = (out.tasks ?? []).filter(t => own(t, 'due'));
  if (
    items.reduce((n, { item }) => n + item.sources.length, dues.length) > 1000
  )
    return 'RESULT_SCHEMA';
  if (
    out.contract !== input.contract ||
    out.requestKey !== input.requestKey ||
    out.inputSha256 !== inputSha256
  ) {
    return 'RESULT_ECHO';
  }
  const present = KINDS.filter(k => own(out, k)).join();
  if (present !== KINDS.filter(k => input.kinds.includes(k)).join())
    return 'RESULT_KINDS';
  if (
    !['', 'work', 'personal', 'work,personal'].includes(
      (out.sections ?? []).map(s => s.area).join(),
    )
  ) {
    return 'RESULT_KINDS';
  }
  // Amendment A1 (§3.2): `omitted` exactly when partial, requested kinds only.
  if ((out.completeness === 'partial') !== own(out, 'omitted')) {
    return 'RESULT_COMPLETENESS';
  }
  if (
    Object.keys(out.omitted ?? {}).some(
      kind => !input.kinds.includes(kind as OrganizeKind),
    )
  ) {
    return 'RESULT_COMPLETENESS';
  }
  for (const { text } of items) if (!textOk(text)) return 'RESULT_TEXT';

  const entryIndex = new Map(input.entries.map((e, i) => [e.entryId, i]));
  const unitOf = (r: SourceRef) => {
    const ei = entryIndex.get(r.entryId);
    if (ei === undefined) return null;
    const e = input.entries[ei];
    const ui = (e.units as { unitId: string }[]).findIndex(
      u => u.unitId === r.unitId,
    );
    return ui < 0
      ? null
      : { ei, ui, e, u: e.units[ui] as VoiceUnit & WrittenUnit };
  };
  const refs = [
    ...items.flatMap(({ item }) => item.sources),
    ...dues.map(t => t.due!.source),
  ];
  if (refs.some(r => !unitOf(r))) return 'RESULT_REFERENCE';
  if (refs.some(r => unitOf(r)!.u.sha256 !== r.unitSha256))
    return 'RESULT_DIGEST';
  for (const r of refs) {
    const { e, u } = unitOf(r)!;
    if (
      !(
        r.charStart >= 0 &&
        r.charStart < r.charEnd &&
        r.charEnd <= u.text.length
      )
    )
      return 'RESULT_RANGE';
    if (splitsPair(u.text, r.charStart) || splitsPair(u.text, r.charEnd))
      return 'RESULT_RANGE';
    const a = own(r, 'audioStartMs');
    const b = own(r, 'audioEndMs');
    if (e.kind === 'voice') {
      if (!a || !b) return 'RESULT_RANGE';
      if (
        !(
          u.startMs <= r.audioStartMs! &&
          r.audioStartMs! < r.audioEndMs! &&
          r.audioEndMs! <= u.endMs
        )
      )
        return 'RESULT_RANGE';
    } else if (a || b) return 'RESULT_RANGE';
  }
  for (const { item } of items) {
    for (let k = 1; k < item.sources.length; k += 1) {
      const x = unitOf(item.sources[k - 1])!;
      const y = unitOf(item.sources[k])!;
      const order =
        cmp(x.ei, y.ei) ||
        cmp(x.ui, y.ui) ||
        cmp(item.sources[k - 1].charStart, item.sources[k].charStart);
      if (order >= 0) return 'RESULT_ORDER';
      if (
        x.ei === y.ei &&
        x.ui === y.ui &&
        item.sources[k - 1].charEnd > item.sources[k].charStart
      )
        return 'RESULT_ORDER';
    }
  }
  // Amendment A2 (§3.3): never trust a node's date; re-derive each one from
  // its cited phrase, the entry's createdAt, and the request's time zone.
  for (const task of dues) {
    const due = task.due!;
    const src = due.source;
    const inside = task.sources.some(
      o =>
        o.entryId === src.entryId &&
        o.unitId === src.unitId &&
        o.charStart <= src.charStart &&
        src.charEnd <= o.charEnd,
    );
    if (!inside) return 'RESULT_DUE';
    const { e, u } = unitOf(src)!;
    const got = deriveDue(
      u.text,
      src.charStart,
      src.charEnd,
      e.createdAt,
      input.timeZone,
    );
    if (!got || got.date !== due.date || got.rule !== due.rule) {
      return 'RESULT_DUE';
    }
  }
  const groups: string[][] = [
    ...(out.sections ?? []).map(s => s.items.map(i => i.text)),
    ...LISTS.map(k =>
      ((out[k] ?? []) as (OrganizeItem | NamedItem)[]).map(i =>
        'text' in i ? i.text : i.name,
      ),
    ),
  ];
  for (const texts of groups) {
    const norm = texts.map(normalizedText);
    if (new Set(norm).size !== norm.length) return 'RESULT_DUPLICATE';
  }
  return null;
}

/** A streamed partial delta: counts only, requested kinds only (§4). */
export function partialOk(
  delta: unknown,
  input: OrganizeInput,
): delta is { counts: Partial<Record<OrganizeKind, number>> } {
  return (
    matchesSchema(partialSchema as Schema, delta) &&
    Object.keys((delta as { counts: object }).counts).every(k =>
      input.kinds.includes(k as OrganizeKind),
    )
  );
}

export type InputCode =
  | 'INPUT_SIZE'
  | 'INPUT_SCHEMA'
  | 'INPUT_TEXT'
  | 'INPUT_DIGEST'
  | 'INPUT_DUPLICATE'
  | 'INPUT_RANGE'
  | 'INPUT_ORDER';

/**
 * Validates a request input as the node will (contract §6.1, in order), so
 * the app never sends one the node must refuse. Returns null when valid.
 */
export function inputViolation(
  input: unknown,
  sha256Hex: (text: string) => string,
): InputCode | null {
  if (canonicalBytes(input) > INPUT_CAP || depthOf(input) > MAX_DEPTH)
    return 'INPUT_SIZE';
  if (!matchesSchema(inputSchema as Schema, input)) return 'INPUT_SCHEMA';
  const { entries } = input as OrganizeInput;
  const units = (e: OrganizeEntry) => e.units as (VoiceUnit & WrittenUnit)[];
  if (entries.reduce((n, e) => n + e.units.length, 0) > 400)
    return 'INPUT_SCHEMA';
  if (
    entries.some(e => units(e).some(u => !textOk(u.text, e.kind === 'written')))
  )
    return 'INPUT_TEXT';
  if (entries.some(e => units(e).some(u => sha256Hex(u.text) !== u.sha256)))
    return 'INPUT_DIGEST';
  if (new Set(entries.map(e => e.entryId)).size !== entries.length)
    return 'INPUT_DUPLICATE';
  if (
    entries.some(
      e => new Set(units(e).map(u => u.unitId)).size !== e.units.length,
    )
  )
    return 'INPUT_DUPLICATE';
  for (const e of entries) {
    for (const u of units(e)) {
      const ok =
        e.kind === 'voice'
          ? u.startMs < u.endMs && u.endMs <= e.durationMs
          : u.offset + u.text.length <= 200_000;
      if (!ok) return 'INPUT_RANGE';
    }
  }
  for (let k = 1; k < entries.length; k += 1) {
    const [a, b] = [entries[k - 1], entries[k]];
    if ((cmp(a.createdAt, b.createdAt) || cmp(a.entryId, b.entryId)) >= 0)
      return 'INPUT_ORDER';
  }
  for (const e of entries) {
    const us = units(e);
    for (let k = 1; k < us.length; k += 1) {
      const [a, b] = [us[k - 1], us[k]];
      if (
        e.kind === 'voice'
          ? b.startMs < a.startMs
          : a.offset + a.text.length > b.offset
      )
        return 'INPUT_ORDER';
    }
  }
  return null;
}
