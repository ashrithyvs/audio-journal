// The first journal.organize@1 engine (ADR-018): deterministic and
// explainable. It segments each unit into sentences and applies fixed phrase
// rules and small lexicons; every item names the rule that produced it and
// cites the exact sentence or name range it came from. No randomness, clock,
// or network: the same input always gives byte-identical output. A
// model-backed engine may replace it behind the same contract and vectors.

import { canonical } from './json.mjs';
import {
  OUTPUT_CAP,
  KINDS,
  sha256,
  textOk,
  normalized,
  validateOutput,
} from './contract.mjs';

export const ENGINE = { id: 'aj.rules', version: '1.0.0' };

const WORK = new Set(
  'meeting meetings client clients customer customers project projects report reports deadline team sprint demo budget office stand-up standup manager boss colleague colleagues presentation slides onboarding design review invoice launch roadmap quarterly agenda proposal contract interview hiring release deploy roadmap kpi okr workshop'.split(
    ' ',
  ),
);
const PERSONAL = new Set(
  'mom mum dad family kids kid son daughter wife husband partner friend friends birthday dinner gym doctor dentist groceries grocery home park walk trip vacation holiday weekend insurance car cleaning laundry neighbourhood neighborhood class club reading movie cooking garden pet dog cat school'.split(
    ' ',
  ),
);
const NAME_AFTER = new Set(
  'with call email tell ask meet text message to from for and visit thank'.split(
    ' ',
  ),
);
const NOT_NAMES = new Set(
  'I The A An This That These Those My Our Your His Her Their We You They It Project Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September October November December Today Tomorrow Tonight Yesterday Morning Evening Idea What Remember Need Pick Book Call Email Send'.split(
    ' ',
  ),
);
const RELATIONS = new Set([
  'Mom',
  'Mum',
  'Dad',
  'Grandma',
  'Grandpa',
  'Granny',
]);

const TASK_RULES = [
  [/\b(?:i|we)\s+(?:really\s+)?need\s+to\s+(.+)/i, 'task.need-to'],
  [/\bneed\s+to\s+(.+)/i, 'task.need-to'],
  [/\b(?:i|we)\s+(?:have|has|got)\s+to\s+(.+)/i, 'task.have-to'],
  [/\b(?:i|we)\s+must\s+(.+)/i, 'task.must'],
  [/\b(?:i|we)\s+should\s+(.+)/i, 'task.should'],
  [/\bdon'?t\s+forget\s+to\s+(.+)/i, 'task.dont-forget'],
  [/\bremember\s+to\s+(.+)/i, 'task.remember'],
  [/\bmake\s+sure\s+(?:to\s+)?(.+)/i, 'task.make-sure'],
  [/^(?:to-?do|todo)\s*[:-]\s*(.+)/i, 'task.todo'],
  [
    /^(?:please\s+)?((?:call|email|send|book|buy|pick up|finish|schedule|renew|pay|submit|fix|prepare|order|reply to|follow up with|write|review)\b.*)/i,
    'task.imperative',
  ],
];
const IDEA_RULES = [
  [/^idea\s*[:-]\s*/i, 'idea.prefix'],
  [/\bwhat\s+if\b/i, 'idea.what-if'],
  [/\bmaybe\s+(?:we|i)\s+could\b/i, 'idea.maybe-could'],
  [/\b(?:we|i)\s+could\s+try\b/i, 'idea.could-try'],
  [/\bit\s+would\s+be\s+(?:nice|great|cool)\s+to\b/i, 'idea.would-be-nice'],
  [/\bi\s+wonder\s+if\b/i, 'idea.wonder-if'],
];
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
const NAME = /(?<![\p{L}\p{N}])(\p{L}+)\s+(\p{Lu}[\p{L}\p{M}'’-]*)/gu;
const RELATION =
  /(?<![\p{L}\p{N}])(Mom|Mum|Dad|Grandma|Grandpa|Granny)(?![\p{L}\p{N}])/gu;
const PROJECT_BEFORE =
  /(?<![\p{L}\p{N}])[Pp]roject\s+(\p{Lu}[\p{L}\p{N}\p{M}'’-]*)/gu;
const PROJECT_AFTER =
  /(?<![\p{L}\p{N}])(\p{Lu}[\p{L}\p{N}\p{M}'’-]*)\s+project(?![\p{L}\p{N}])/gu;

export class EngineError extends Error {}

/** Single-line text: no controls or line breaks, whitespace collapsed. */
function clean(text) {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0);
    const bad =
      c <= 0x1f ||
      (c >= 0x7f && c <= 0x9f) ||
      c === 0x2028 ||
      c === 0x2029 ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069);
    out += bad ? ' ' : ch;
  }
  return out.replace(/\s+/gu, ' ').trim();
}

/** Shortens to `max` UTF-16 units without splitting a surrogate pair. */
function fit(text, max) {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  const space = cut.lastIndexOf(' ');
  if (space > max * 0.6) cut = cut.slice(0, space);
  return `${cut.trimEnd()}…`;
}

function sentenceCase(text) {
  const t = text.replace(/[\s.!?;,:]+$/u, '');
  if (!t) return '';
  return `${t[0].toUpperCase()}${t.slice(1)}.`;
}

/** Sentences of one unit with their UTF-16 ranges in the unit text. */
function sentences(unit) {
  const out = [];
  for (const m of unit.text.matchAll(/[^.!?\n]+(?:[.!?]+|(?=\n)|$)/g)) {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const body = raw.trim();
    if (!/[\p{L}\p{N}]/u.test(body)) continue;
    const start = m.index + lead;
    out.push({ start, end: start + body.length, raw: body, text: clean(body) });
  }
  return out;
}

function area(text) {
  let work = 0;
  let personal = 0;
  for (const m of text.toLowerCase().matchAll(WORD)) {
    if (WORK.has(m[0])) work += 1;
    if (PERSONAL.has(m[0])) personal += 1;
  }
  return work > personal ? 'work' : personal > work ? 'personal' : null;
}

/**
 * Organizes a validated input. Calls `step(stage, fraction)` between stages
 * (the caller checks deadlines and cancellation there) and `partial(counts)`
 * once, after extraction.
 */
export function organize(input, { step = () => {}, partial = () => {} } = {}) {
  step('received', 0.05);
  const ref = (s, from = s.start, to = s.end) => {
    const r = {
      entryId: s.entry.entryId,
      unitId: s.unit.unitId,
      unitSha256: s.unit.sha256,
      charStart: from,
      charEnd: to,
    };
    if (s.entry.kind === 'voice') {
      r.audioStartMs = s.unit.startMs;
      r.audioEndMs = s.unit.endMs;
    }
    return r;
  };

  step('segmenting', 0.2);
  const all = [];
  input.entries.forEach((entry, ei) => {
    entry.units.forEach((unit, ui) => {
      for (const s of sentences(unit)) all.push({ ...s, entry, unit, ei, ui });
    });
  });

  step('extracting', 0.5);
  // Items keyed by normalized text; sources merge in source order.
  const lists = {
    work: [],
    personal: [],
    tasks: [],
    ideas: [],
    people: [],
    projects: [],
  };
  const seen = Object.fromEntries(Object.keys(lists).map(k => [k, new Map()]));
  const add = (kind, item, source, order) => {
    const field = kind === 'people' || kind === 'projects' ? 'name' : 'text';
    const value = item[field];
    if (!value || !textOk(value, false)) return;
    const key = normalized(value);
    const existing = seen[kind].get(key);
    if (existing) {
      existing.refs.push({ source, order });
      return;
    }
    const entry = { item, refs: [{ source, order }] };
    seen[kind].set(key, entry);
    lists[kind].push(entry);
  };

  for (const s of all) {
    const order = [s.ei, s.ui, s.start];
    const sentenceArea = area(s.text);
    let isTask = false;
    for (const [re, rule] of TASK_RULES) {
      const m = re.exec(s.text);
      if (!m) continue;
      const text = fit(sentenceCase(m[1]), 400);
      if (text) {
        add(
          'tasks',
          { text, area: sentenceArea ?? 'unsorted', rule },
          ref(s),
          order,
        );
        isTask = true;
      }
      break;
    }
    if (!isTask) {
      for (const [re, rule] of IDEA_RULES) {
        if (!re.test(s.text)) continue;
        const text = fit(
          sentenceCase(s.text.replace(/^idea\s*[:-]\s*/i, '')),
          400,
        );
        add('ideas', { text, rule }, ref(s), order);
        break;
      }
    }
    if (sentenceArea) {
      add(
        sentenceArea,
        { text: fit(s.text, 400), rule: `area.${sentenceArea}` },
        ref(s),
        order,
      );
    }
    for (const m of s.raw.matchAll(NAME)) {
      const name = m[2].replace(/['’]s$/u, '');
      if (
        !NAME_AFTER.has(m[1].toLowerCase()) ||
        NOT_NAMES.has(name) ||
        name.length < 2
      )
        continue;
      const at = s.start + m.index + m[0].length - m[2].length;
      add(
        'people',
        { name: fit(name, 80), rule: 'person.after-verb' },
        ref(s, at, at + name.length),
        [s.ei, s.ui, at],
      );
    }
    for (const m of s.raw.matchAll(RELATION)) {
      if (!RELATIONS.has(m[1])) continue;
      const at = s.start + m.index;
      add(
        'people',
        { name: m[1], rule: 'person.relation' },
        ref(s, at, at + m[1].length),
        [s.ei, s.ui, at],
      );
    }
    for (const re of [PROJECT_BEFORE, PROJECT_AFTER]) {
      for (const m of s.raw.matchAll(re)) {
        const at = s.start + m.index;
        add(
          'projects',
          { name: fit(m[1], 80), rule: 'project.named' },
          ref(s, at, at + m[0].length),
          [s.ei, s.ui, at],
        );
      }
    }
  }

  /** Up to 8 sources in source order, without overlap in one unit. */
  const finish = ({ item, refs }) => {
    const sorted = [...refs].sort(
      (a, b) =>
        a.order[0] - b.order[0] ||
        a.order[1] - b.order[1] ||
        a.order[2] - b.order[2],
    );
    const sources = [];
    for (const { source } of sorted) {
      const prev = sources[sources.length - 1];
      if (
        prev &&
        prev.entryId === source.entryId &&
        prev.unitId === source.unitId &&
        prev.charEnd > source.charStart
      )
        continue;
      if (sources.length < 8) sources.push(source);
    }
    return { ...item, sources };
  };
  const counts = {
    summary: all.length ? 1 : 0,
    sections:
      Math.min(50, lists.work.length) + Math.min(50, lists.personal.length),
    tasks: Math.min(50, lists.tasks.length),
    ideas: Math.min(50, lists.ideas.length),
    people: Math.min(50, lists.people.length),
    projects: Math.min(50, lists.projects.length),
  };
  partial(
    Object.fromEntries(
      KINDS.filter(k => input.kinds.includes(k)).map(k => [k, counts[k]]),
    ),
  );

  step('checking', 0.9);
  const out = {
    contract: 'journal.organize@1',
    requestKey: input.requestKey,
    inputSha256: sha256(canonical(input)),
    engine: { ...ENGINE },
  };
  if (input.kinds.includes('summary')) {
    // The opening sentence of up to three entries.
    const lead = [];
    const seenEntries = new Set();
    for (const s of all) {
      if (seenEntries.has(s.ei) || lead.length >= 3) continue;
      seenEntries.add(s.ei);
      lead.push(s);
    }
    if (!lead.length) {
      // No word-like sentence: cite the first unit as a whole.
      const entry = input.entries[0];
      const unit = entry.units[0];
      lead.push({
        entry,
        unit,
        ei: 0,
        ui: 0,
        start: 0,
        end: unit.text.length,
        text: clean(unit.text),
      });
    }
    out.summary = {
      text: fit(lead.map(s => s.text).join(' '), 600),
      rule: 'summary.lead',
      sources: lead.map(s => ref(s)),
    };
  }
  if (input.kinds.includes('sections')) {
    out.sections = ['work', 'personal']
      .filter(a => lists[a].length)
      .map(a => ({ area: a, items: lists[a].slice(0, 50).map(finish) }));
  }
  for (const kind of ['tasks', 'ideas', 'people', 'projects']) {
    if (input.kinds.includes(kind))
      out[kind] = lists[kind].slice(0, 50).map(finish);
  }

  // Keep within the output cap: drop the last item of the longest list.
  for (
    let guard = 0;
    Buffer.byteLength(canonical(out), 'utf8') > OUTPUT_CAP;
    guard += 1
  ) {
    const candidates = [
      ...['tasks', 'ideas', 'people', 'projects']
        .filter(k => out[k]?.length)
        .map(k => [k, out[k]]),
      ...(out.sections ?? []).map(s => [`section:${s.area}`, s.items]),
    ].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
    if (!candidates.length || guard > 10_000)
      throw new EngineError('cannot fit the output cap');
    candidates[0][1].pop();
    if (out.sections) out.sections = out.sections.filter(s => s.items.length);
  }
  validateOutput(out, input); // the node never sends what the app would reject
  step('checking', 1);
  return out;
}
