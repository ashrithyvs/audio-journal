import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  canonicalBytes,
  canonicalJson,
  INPUT_CAP,
  inputViolation,
  MESSAGE_CAP,
  OUTPUT_CAP,
  parseStrictJson,
  partialOk,
  resultViolation,
  type OrganizeInput,
} from '../src/features/organize/domain/contract';
import { requestKeyOf } from '../src/features/organize/domain/request';

// The app's journal.organize@1 checks against every frozen vector
// (schemas/journal/v1). Each case is fed as the wire would carry it.

const ROOT = path.join(__dirname, '..', 'schemas', 'journal', 'v1');
const read = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8'));
const manifest = read('vectors.json');
const fixtures: Record<string, OrganizeInput> = read('vectors/fixtures.json');
const inputs = read('vectors/inputs.json');
const results = read('vectors/results.json');
const events = read('vectors/events.json');
const envelopes = read('vectors/envelopes.json');
const keys = read('vectors/request-keys.json');

const sha256Hex = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');
const crypto = {
  sha256Hex,
  hmacSha256Hex: (keyHex: string, label: string, text: string) =>
    createHmac('sha256', Buffer.from(keyHex, 'hex'))
      .update(
        Buffer.concat([
          Buffer.from(label, 'utf8'),
          Buffer.from([0]),
          Buffer.from(text, 'utf8'),
        ]),
      )
      .digest('hex'),
};

/** A wire value: strict parse of text cases, or the canonical form. */
function wire(text: string | undefined, value: unknown): unknown {
  return text === undefined ? value : parseStrictJson(text) ?? Symbol('bad');
}

it('pins the vector files by digest and the message budget', () => {
  for (const [file, digest] of Object.entries(
    manifest.files as Record<string, string>,
  )) {
    const bytes = fs.readFileSync(path.join(ROOT, file));
    expect([file, createHash('sha256').update(bytes).digest('hex')]).toEqual([
      file,
      digest,
    ]);
  }
  expect(manifest.budget).toMatchObject({
    messageCap: MESSAGE_CAP,
    inputCap: INPUT_CAP,
    outputCap: OUTPUT_CAP,
  });
});

it('reaches every input verdict in the frozen order (§6.1)', () => {
  expect(inputs).toHaveLength(manifest.counts.inputs);
  for (const c of inputs) {
    const value = wire(c.inputText, c.input);
    const code =
      typeof value === 'symbol'
        ? 'INPUT_SCHEMA'
        : inputViolation(value, sha256Hex);
    expect([c.name, code ? { valid: false, code } : { valid: true }]).toEqual([
      c.name,
      c.expect,
    ]);
  }
});

it('reaches every result verdict and sub-code (§6)', () => {
  expect(results).toHaveLength(manifest.counts.results);
  for (const c of results) {
    const input = fixtures[c.fixture];
    const text = c.resultBase64
      ? (() => {
          // Invalid UTF-8 never decodes into a result.
          const bytes = Buffer.from(c.resultBase64, 'base64');
          const decoded = new TextDecoder('utf-8', { fatal: false }).decode(
            bytes,
          );
          return Buffer.from(decoded, 'utf8').equals(bytes)
            ? decoded
            : '\u0000';
        })()
      : c.resultText;
    const value = wire(text, c.result);
    const code =
      typeof value === 'symbol'
        ? 'RESULT_SCHEMA'
        : resultViolation(value, input, sha256Hex(canonicalJson(input)));
    expect([c.name, code ? { valid: false, code } : { valid: true }]).toEqual([
      c.name,
      c.expect,
    ]);
  }
});

it('accepts the exact caps and refuses one byte over', () => {
  expect(canonicalBytes(fixtures.max)).toBe(INPUT_CAP);
  const max = results.find(
    (c: { name: string }) => c.name === 'valid-maxOutput',
  );
  expect(canonicalBytes(max.result)).toBe(OUTPUT_CAP);
  // Whole messages with the SDK's published envelopes (§8.1).
  const resolve = (ref: string) => {
    const [kind, name] = ref.split(':');
    if (kind === 'fixture') return fixtures[name];
    const list = kind === 'input' ? inputs : results;
    const found = list.find((c: { name: string }) => c.name === name);
    return kind === 'input' ? found.input : found.result;
  };
  for (const e of envelopes) {
    const message =
      e.kind === 'jobRequest'
        ? {
            capability: { id: 'journal.organize', version: e.envelope.version },
            deadlineMs: e.envelope.deadlineMs,
            idempotencyKey: e.envelope.idempotencyKey,
            input: resolve(e.input),
            requestId: e.envelope.requestId,
            stream: e.envelope.stream,
          }
        : {
            data: { output: resolve(e.output) },
            sequence: e.sequence,
            type: 'completed',
          };
    const bytes = canonicalBytes(message);
    expect([e.name, bytes, bytes <= MESSAGE_CAP]).toEqual([
      e.name,
      e.expect.bytes,
      e.expect.withinCap,
    ]);
  }
});

it('counts partials only for requested kinds (§4)', () => {
  for (const c of events) {
    const input = fixtures[c.fixture ?? 'mixed'];
    let ok = 0;
    let ignored = 0;
    for (const e of c.events) {
      if (['completed', 'failed', 'cancelled'].includes(e.type)) break;
      if (e.type === 'partial') {
        if (partialOk(e.delta, input)) ok += 1;
        else ignored += 1;
      }
    }
    expect([c.name, ok, ignored]).toEqual([
      c.name,
      c.expect.partials,
      c.expect.ignoredPartials ?? 0,
    ]);
  }
});

it('derives every published request key (§9)', () => {
  expect(keys.cases).toHaveLength(manifest.counts.requestKeys);
  for (const c of keys.cases) {
    expect([c.name, requestKeyOf(c.input, keys.testKeyHex, crypto)]).toEqual([
      c.name,
      c.expect.requestKey,
    ]);
  }
});
