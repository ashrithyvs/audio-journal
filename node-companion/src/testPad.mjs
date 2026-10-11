// Test-only (`serve --test-pad-results`; never on by default): grows a valid
// result to exactly OUTPUT_CAP canonical bytes with extra `ideas` items, so a
// device suite can prove that the SDK accepts a `completed` message at the
// contract's 61,440-byte budget (journal-organize.md §8.1). The padded result
// still passes every §6 rule; when that cannot be achieved, the engine's own
// result is returned unchanged.

import { OUTPUT_CAP, resultViolation } from './contract.mjs';
import { byteLength } from './json.mjs';

const MAX_ITEMS = 50;
const MAX_REFS = 8;
const MAX_TEXT = 400;

/** One-code-point references, in contract order, across the request's units. */
function references(input, limit) {
  const refs = [];
  for (const entry of input.entries) {
    for (const unit of entry.units) {
      for (let i = 0; i < unit.text.length && refs.length < limit; ) {
        const code = unit.text.codePointAt(i);
        const end = i + (code > 0xffff ? 2 : 1);
        refs.push({
          entryId: entry.entryId,
          unitId: unit.unitId,
          unitSha256: unit.sha256,
          charStart: i,
          charEnd: end,
          ...(entry.kind === 'voice'
            ? { audioStartMs: unit.startMs, audioEndMs: unit.endMs }
            : {}),
        });
        i = end;
      }
    }
  }
  return refs;
}

export function padToCap(output, input) {
  if (!Array.isArray(output.ideas)) return output;
  const out = structuredClone(output);
  const refs = references(input, MAX_REFS);
  if (refs.length === 0) return output;
  for (let n = 1; byteLength(out) < OUTPUT_CAP; n += 1) {
    if (out.ideas.length >= MAX_ITEMS) return output;
    const label = `Padding idea ${n} `;
    const item = {
      text: label.padEnd(MAX_TEXT, 'x'),
      sources: refs.map(ref => ({ ...ref })),
    };
    out.ideas.push(item);
    // Drop references, then characters, until the size is exact.
    while (byteLength(out) > OUTPUT_CAP && item.sources.length > 1) {
      const without = byteLength(out) - OUTPUT_CAP;
      const last = byteLength(item.sources.at(-1)) + 1;
      if (without < item.text.length - label.length && without < last) break;
      item.sources.pop();
    }
    const over = byteLength(out) - OUTPUT_CAP;
    if (over > 0) {
      if (item.text.length - over < label.trimEnd().length) return output;
      item.text = item.text.slice(0, item.text.length - over).trimEnd();
      // Trimming a trailing space would undershoot; pad back with x.
      while (byteLength(out) < OUTPUT_CAP) item.text += 'x';
    }
  }
  return byteLength(out) === OUTPUT_CAP && resultViolation(out, input) === null
    ? out
    : output;
}
