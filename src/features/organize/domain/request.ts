// journal.organize@1 requests (docs/journal-organize.md §2, §9): which text of
// the selected entries is sent, how written text is split into units, and the
// opaque request key. Nothing here truncates or rewrites content: a selection
// the contract cannot carry is refused and the reason is shown.

import type { JournalEntryDetail } from '../../journal/ports/JournalRepository';
import {
  canonicalBytes,
  canonicalJson,
  CONTRACT,
  inputViolation,
  KINDS,
  textOk,
  type InputCode,
  type OrganizeEntry,
  type OrganizeInput,
  type OrganizeKind,
  type VoiceUnit,
  type WrittenUnit,
} from './contract';

/** Platform digests; the app adapter is native, tests use node:crypto. */
export interface OrganizeCrypto {
  /** SHA-256 of the text's UTF-8 bytes, lower-case hex. */
  sha256Hex(text: string): string;
  /** HMAC-SHA256(key, label || 0x00 || UTF-8 text), lower-case hex. */
  hmacSha256Hex(keyHex: string, label: string, text: string): string;
}

export const ORGANIZE_LIMITS = {
  maxEntries: 20,
  maxUnits: 400,
  maxUnitChars: 4000,
} as const;

/** Why a selected entry contributes nothing (§2: never sent). */
export type ExclusionReason =
  | 'not_ready'
  | 'no_transcript'
  | 'empty_transcript'
  | 'no_text';

export interface Exclusion {
  entryId: string;
  reason: ExclusionReason;
}

export type RefusalReason =
  | 'NOTHING_TO_ORGANIZE'
  | 'TOO_MANY_ENTRIES'
  | 'TOO_MANY_UNITS'
  | 'TOO_LARGE'
  /** Written text with characters the contract cannot carry (§2). */
  | 'UNSENDABLE_TEXT'
  /** A built request failed the node's own checks; a defect, never sent. */
  | InputCode;

export type BuiltRequest =
  | {
      ok: true;
      input: OrganizeInput;
      /** SHA-256 of the canonical input; the result must echo it (§3). */
      inputSha256: string;
      /** Entry IDs in request order. */
      included: string[];
      excluded: Exclusion[];
      units: number;
      bytes: number;
    }
  | {
      ok: false;
      reason: RefusalReason;
      excluded: Exclusion[];
      entryId?: string;
    };

// ------------------------------------------------------------- written text

// A paragraph runs to the next blank line (one holding only spaces or tabs).
const PARAGRAPH = /[^\n]+(?:\n(?![ \t]*\n)[^\n]*)*/g;
const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;

/**
 * Splits a written entry into units (§2): paragraphs at blank lines; a
 * paragraph over 4,000 UTF-16 code units at its last sentence end inside the
 * limit, else at 4,000 without splitting a surrogate pair. Each unit is the
 * exact substring at its offset, trimmed; blank pieces are dropped.
 */
export function writtenUnits(
  sourceText: string,
): Array<{ text: string; offset: number }> {
  const out: Array<{ text: string; offset: number }> = [];
  const push = (raw: string, at: number) => {
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text) out.push({ text, offset: at + lead });
  };
  const max = ORGANIZE_LIMITS.maxUnitChars;
  for (const match of sourceText.matchAll(PARAGRAPH)) {
    let rest = match[0];
    let at = match.index ?? 0;
    const skip = () => {
      const lead = rest.length - rest.trimStart().length;
      rest = rest.slice(lead);
      at += lead;
    };
    skip();
    while (rest.trimEnd().length > max) {
      let cut = 0;
      for (let i = max - 1; i >= 0 && cut === 0; i -= 1) {
        if ('.!?'.includes(rest[i]) && rest[i + 1] === ' ') cut = i + 1;
      }
      if (cut === 0) cut = isHigh(rest.charCodeAt(max - 1)) ? max - 1 : max;
      push(rest.slice(0, cut), at);
      rest = rest.slice(cut);
      at += cut;
      skip();
    }
    push(rest, at);
  }
  return out;
}

// ------------------------------------------------------------- context

const LOCALE = /^[a-z]{2,3}(-[A-Z]{2})?$/;
const TIME_ZONE = /^[A-Za-z]+(\/[A-Za-z0-9_+-]+){0,2}$/;

/** The device locale and time zone, reduced to what the contract carries. */
export function deviceContext(
  resolved: () => { locale?: string; timeZone?: string } = () =>
    Intl.DateTimeFormat().resolvedOptions(),
): { locale: string; timeZone: string } {
  let locale = 'und';
  let timeZone = 'UTC';
  try {
    const options = resolved();
    const tags = (options.locale ?? '').split(/[-_]/);
    const language = (tags[0] ?? '').toLowerCase();
    const region = tags.slice(1).find(tag => /^[A-Za-z]{2}$/.test(tag));
    const candidate = region ? `${language}-${region.toUpperCase()}` : language;
    if (LOCALE.test(candidate)) locale = candidate;
    else if (LOCALE.test(language)) locale = language;
    if (
      options.timeZone &&
      TIME_ZONE.test(options.timeZone) &&
      options.timeZone.length <= 64
    ) {
      timeZone = options.timeZone;
    }
  } catch {
    // Context only (§2): the defaults stand.
  }
  return { locale, timeZone };
}

// ------------------------------------------------------------- request key

const B32 = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * §9: `org_` + the first 26 Crockford base32 characters of
 * HMAC-SHA256(K, "journal.organize@1" || 0x00 || canonical input without
 * requestKey). Opaque, stable for an identical request, new for any change.
 */
export function requestKeyOf(
  input: Omit<OrganizeInput, 'requestKey'> & { requestKey?: string },
  keyHex: string,
  crypto: OrganizeCrypto,
): string {
  const rest: Record<string, unknown> = { ...input };
  delete rest.requestKey;
  const mac = crypto.hmacSha256Hex(keyHex, CONTRACT, canonicalJson(rest));
  let bits = '';
  for (let i = 0; i < mac.length; i += 2) {
    bits += parseInt(mac.slice(i, i + 2), 16)
      .toString(2)
      .padStart(8, '0');
  }
  let out = '';
  for (let i = 0; i < 26; i += 1)
    out += B32[parseInt(bits.slice(i * 5, i * 5 + 5), 2)];
  return `org_${out}`;
}

// ------------------------------------------------------------- building

function entryOf(
  detail: JournalEntryDetail,
  crypto: OrganizeCrypto,
): OrganizeEntry | ExclusionReason | 'UNSENDABLE_TEXT' {
  const { entry } = detail;
  if (entry.status !== 'ready') return 'not_ready';
  const createdAt = new Date(entry.createdAt).toISOString();
  if (entry.kind === 'written') {
    const pieces = writtenUnits(entry.sourceText ?? '');
    if (pieces.length === 0) return 'no_text';
    if (pieces.some(p => !textOk(p.text, true))) return 'UNSENDABLE_TEXT';
    const units: WrittenUnit[] = pieces.map((p, i) => ({
      unitId: `w${i}`,
      text: p.text,
      sha256: crypto.sha256Hex(p.text),
      offset: p.offset,
    }));
    return { entryId: entry.id, kind: 'written', createdAt, units };
  }
  const { recording, transcript } = detail;
  if (!recording || recording.state !== 'ready') return 'not_ready';
  if (transcript.kind === 'empty') return 'empty_transcript';
  if (transcript.kind !== 'final' || transcript.lines.length === 0)
    return 'no_transcript';
  const units: VoiceUnit[] = transcript.lines.map(line => ({
    unitId: line.segmentId,
    text: line.text,
    sha256: crypto.sha256Hex(line.text),
    startMs: line.startMs,
    endMs: line.endMs,
  }));
  return {
    entryId: entry.id,
    kind: 'voice',
    createdAt,
    recordingId: recording.id,
    transcriptRevision: transcript.engineRevision,
    durationMs: recording.durationMs,
    units,
  };
}

/**
 * Builds the request for a selection of whole entries (§2, ADR-019 decision
 * 10). Entries with nothing finalized are left out and reported; anything the
 * contract cannot carry refuses the whole request.
 */
export function buildOrganizeRequest(options: {
  selection: readonly JournalEntryDetail[];
  keyHex: string;
  crypto: OrganizeCrypto;
  kinds?: readonly OrganizeKind[];
  context?: { locale: string; timeZone: string };
}): BuiltRequest {
  const { selection, keyHex, crypto } = options;
  const excluded: Exclusion[] = [];
  if (selection.length > ORGANIZE_LIMITS.maxEntries) {
    return { ok: false, reason: 'TOO_MANY_ENTRIES', excluded };
  }
  const entries: OrganizeEntry[] = [];
  for (const detail of selection) {
    const built = entryOf(detail, crypto);
    if (built === 'UNSENDABLE_TEXT') {
      return { ok: false, reason: built, excluded, entryId: detail.entry.id };
    }
    if (typeof built === 'string')
      excluded.push({ entryId: detail.entry.id, reason: built });
    else entries.push(built);
  }
  if (entries.length === 0)
    return { ok: false, reason: 'NOTHING_TO_ORGANIZE', excluded };
  entries.sort((a, b) =>
    a.createdAt < b.createdAt
      ? -1
      : a.createdAt > b.createdAt
      ? 1
      : a.entryId < b.entryId
      ? -1
      : a.entryId > b.entryId
      ? 1
      : 0,
  );
  const units = entries.reduce((n, e) => n + e.units.length, 0);
  if (units > ORGANIZE_LIMITS.maxUnits)
    return { ok: false, reason: 'TOO_MANY_UNITS', excluded };
  const kinds = KINDS.filter(kind => (options.kinds ?? KINDS).includes(kind));
  const context = options.context ?? deviceContext();
  const unkeyed = {
    contract: CONTRACT,
    locale: context.locale,
    timeZone: context.timeZone,
    kinds,
    entries,
  } as const;
  const input: OrganizeInput = {
    ...unkeyed,
    kinds: [...kinds],
    requestKey: requestKeyOf({ ...unkeyed, kinds: [...kinds] }, keyHex, crypto),
  };
  const violation = inputViolation(input, crypto.sha256Hex);
  if (violation === 'INPUT_SIZE')
    return { ok: false, reason: 'TOO_LARGE', excluded };
  if (violation) return { ok: false, reason: violation, excluded };
  const text = canonicalJson(input);
  return {
    ok: true,
    input,
    inputSha256: crypto.sha256Hex(text),
    included: entries.map(e => e.entryId),
    excluded,
    units,
    bytes: canonicalBytes(input),
  };
}
