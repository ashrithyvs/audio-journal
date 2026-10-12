// Job-store limits with a controllable clock (SDK ADR-021): 15-minute
// retention, 32 retained jobs, the 64-event stream cap, the message budget,
// and bounded idempotency records.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MESSAGE_CAP } from '../src/contract.mjs';
import {
  MAX_EVENTS,
  MAX_IDEMPOTENCY,
  MAX_JOBS,
  JobStore,
  RETENTION_MS,
  WireError,
} from '../src/jobs.mjs';
import { canonical } from '../src/json.mjs';

const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'schemas',
  'journal',
  'v1',
);
const fixtures = JSON.parse(
  readFileSync(join(ROOT, 'vectors', 'fixtures.json'), 'utf8'),
);

let n = 0;
const body = (input = fixtures.voice) => ({
  requestId: `r${(n += 1)}`,
  idempotencyKey: `key-${String(n).padStart(16, '0')}`,
  capability: { id: 'journal.organize', version: '1.0.0' },
  input,
  deadlineMs: 120_000,
  stream: true,
});
const settle = () => new Promise(r => setTimeout(r, 20));

function store(options = {}) {
  let now = 0;
  const s = new JobStore({ monotonic: () => now, ...options });
  return { s, advance: ms => (now += ms) };
}

test('jobs are retained for 15 minutes, then JOB_NOT_RETAINED', async () => {
  const { s, advance } = store();
  const { body: r } = s.submit('p1', body());
  await settle();
  assert.equal(s.status('p1', r.jobId).state, 'completed');
  advance(RETENTION_MS - 1);
  assert.equal(s.status('p1', r.jobId).state, 'completed');
  advance(1);
  assert.throws(
    () => s.status('p1', r.jobId),
    e =>
      e instanceof WireError &&
      e.code === 'JOB_NOT_RETAINED' &&
      e.status === 404,
  );
});

test('at most 32 jobs: the oldest finished job makes room; 32 running jobs refuse a 33rd', async () => {
  const { s } = store();
  const ids = [];
  for (let i = 0; i < MAX_JOBS; i += 1)
    ids.push(s.submit('p1', body()).body.jobId);
  await settle();
  const extra = s.submit('p1', body());
  assert.equal(extra.status, 201);
  assert.equal(s.jobs.size, MAX_JOBS);
  assert.throws(
    () => s.status('p1', ids[0]),
    e => e.code === 'JOB_NOT_RETAINED',
  );

  const busy = store({ stageDelayMs: 1000 });
  for (let i = 0; i < MAX_JOBS; i += 1) busy.s.submit('p1', body());
  await settle();
  assert.throws(
    () => busy.s.submit('p1', body()),
    e => e.status === 503 && e.code === 'NODE_UNAVAILABLE',
  );
  for (const job of busy.s.jobs.values()) busy.s.end(job, 'cancelled', 'test');
});

test('a stream never exceeds 64 events and always ends with its terminal', () => {
  const { s } = store();
  const job = {
    jobId: 'a'.repeat(32),
    pairingId: 'p',
    state: 'accepted',
    sequence: 0,
    events: [],
    listeners: new Set(),
    timer: null,
  };
  for (let i = 0; i < 100; i += 1)
    s.emit(job, 'progress', { stage: 'extracting', fraction: 0.5 });
  assert.equal(job.events.length, MAX_EVENTS - 1);
  s.end(job, 'completed', { ok: true });
  assert.equal(job.events.length, MAX_EVENTS);
  assert.equal(job.events.at(-1).type, 'completed');
  assert.equal(job.events.at(-1).sequence, 64);
});

test('an event message over 61,440 bytes is never sent; an oversized result fails', () => {
  const { s } = store();
  const job = {
    jobId: 'b'.repeat(32),
    pairingId: 'p',
    state: 'accepted',
    sequence: 0,
    events: [],
    listeners: new Set(),
    timer: null,
  };
  const fits = { pad: 'x'.repeat(MESSAGE_CAP - 70) };
  s.emit(job, 'partial', { delta: { pad: 'y'.repeat(MESSAGE_CAP) } });
  assert.equal(job.events.length, 0);
  s.end(job, 'completed', { pad: 'z'.repeat(MESSAGE_CAP) });
  assert.equal(job.events.at(-1).type, 'failed');
  assert.equal(job.events.at(-1).data.code, 'EXECUTION_FAILED');
  for (const e of job.events)
    assert.ok(Buffer.byteLength(canonical(e)) <= MESSAGE_CAP);
  assert.ok(
    Buffer.byteLength(
      canonical({ data: { output: fits }, sequence: 64, type: 'completed' }),
    ) <= MESSAGE_CAP,
  );
});

test('idempotency records are bounded and never evicted', () => {
  const { s } = store();
  for (let i = 0; i < MAX_IDEMPOTENCY; i += 1)
    s.idempotency.set(`p1 filler-${i}`, {
      identity: '',
      jobId: '',
      requestId: '',
    });
  assert.throws(
    () => s.submit('p1', body()),
    e => e.status === 503 && e.code === 'NODE_UNAVAILABLE',
  );
});

test('revocation cancels the pairing’s jobs and forgets its keys', async () => {
  const { s } = store({ stageDelayMs: 500 });
  const a = s.submit('p1', body()).body.jobId;
  const b = s.submit('p2', body()).body.jobId;
  await settle();
  s.revokePairing('p1');
  assert.equal(s.jobs.get(a).state, 'cancelled');
  assert.notEqual(s.jobs.get(b).state, 'cancelled');
  assert.equal(
    [...s.idempotency.keys()].some(k => k.startsWith('p1 ')),
    false,
  );
  s.revokePairing('p2');
});
