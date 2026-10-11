// The companion end to end over TLS on loopback: pairing, authorization,
// capabilities, jobs, events, idempotency, deadlines, cancellation,
// retention, strict JSON, size limits, and revocation (SDK ADR-021/022;
// journal.organize@1 contract).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { INPUT_CAP, MESSAGE_CAP, resultViolation } from '../src/contract.mjs';
import { loadIdentity } from '../src/identity.mjs';
import { startCompanion } from '../src/server.mjs';
import { canonical, job, makeDevice } from './device.mjs';

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
const inputs = JSON.parse(
  readFileSync(join(ROOT, 'vectors', 'inputs.json'), 'utf8'),
);

async function startNode(options = {}) {
  const identity = await loadIdentity(mkdtempSync(join(tmpdir(), 'aj-node-')));
  const node = await startCompanion(identity, {
    host: '127.0.0.1',
    ...options,
  });
  return { identity, node, nodeKey: identity.nodeKey, port: node.port };
}

async function paired(options) {
  const n = await startNode(options);
  const device = await makeDevice(n);
  const result = await device.pair(n.node.pairing, [
    { host: '127.0.0.1', port: n.port },
  ]);
  assert.equal(result.confirmed.body.state, 'paired');
  return { ...n, device };
}

async function run(device, input, overrides) {
  const submitted = await device.request(
    'POST',
    '/v1/jobs',
    job(input, overrides),
  );
  assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
  const stream = await device.events(submitted.body.jobId);
  return { submitted, stream };
}

test('an unpaired device reaches nothing but pairing', async t => {
  const n = await startNode();
  t.after(() => n.node.close());
  const device = await makeDevice(n);
  for (const [method, path] of [
    ['GET', '/v1/info'],
    ['GET', '/v1/capabilities'],
    ['POST', '/v1/jobs'],
    ['GET', `/v1/jobs/${'a'.repeat(32)}`],
  ]) {
    const r = await device.request(
      method,
      path,
      method === 'POST' ? job(fixtures.voice) : undefined,
    );
    assert.equal(r.status, 403, path);
    assert.equal(r.body.code, 'DEVICE_NOT_PAIRED');
  }
  const ws = await device.events('a'.repeat(32));
  assert.equal(ws.status, 403);
});

test('pairing: matching codes, then info and the journal.organize descriptor', async t => {
  const { node, device, identity } = await paired();
  t.after(() => node.close());
  const info = await device.request('GET', '/v1/info');
  assert.deepEqual(info.body, {
    nodeId: identity.nodeId,
    protocolVersion: '1.0',
    supportedVersions: ['1.0'],
    health: 'ok',
  });
  assert.equal(info.headers['content-length'], String(info.bytes.length));
  assert.equal(info.headers['transfer-encoding'], undefined);
  const caps = await device.request('GET', '/v1/capabilities');
  const [d] = caps.body.capabilities;
  assert.equal(caps.body.capabilities.length, 1);
  assert.deepEqual(Object.keys(d).sort(), [
    'id',
    'inputSchema',
    'maximumInputBytes',
    'outputSchema',
    'preferred',
    'streaming',
    'version',
  ]);
  assert.equal(d.id, 'journal.organize');
  assert.equal(d.version, '1.0.0');
  assert.equal(d.maximumInputBytes, INPUT_CAP);
  assert.equal(d.streaming, true);
  assert.deepEqual(
    d.inputSchema,
    JSON.parse(readFileSync(join(ROOT, 'organize-input.schema.json'), 'utf8')),
  );
  assert.deepEqual(
    d.outputSchema,
    JSON.parse(readFileSync(join(ROOT, 'organize-output.schema.json'), 'utf8')),
  );
  const nodeKey = await device.request('GET', '/v1/pairing/node-key');
  assert.deepEqual(nodeKey.body, {
    v: 1,
    nodeId: identity.nodeId,
    current: identity.nodeKey,
  });
  assert.equal(
    statSync(join(identity.stateDir, 'pairings.json')).mode & 0o777,
    0o600,
  );
  assert.equal(
    statSync(join(identity.stateDir, 'node-key.pem')).mode & 0o777,
    0o600,
  );
});

test('pairing: a mismatched code is rejected and a second start for the session fails', async t => {
  const n = await startNode();
  t.after(() => n.node.close());
  const device = await makeDevice(n);
  const result = await device.pair(
    n.node.pairing,
    [{ host: '127.0.0.1', port: n.port }],
    () => 'reject',
  );
  assert.equal(result.confirmed.body.state, 'rejected');
  assert.equal(result.code, result.nodeCode);
  const again = await device.request('GET', '/v1/info');
  assert.equal(again.status, 403);
});

test('pairing: trust is persisted only after both the device and the operator accept', async t => {
  const n = await startNode();
  t.after(() => n.node.close());
  const endpoints = [{ host: '127.0.0.1', port: n.port }];

  // The operator approves first; the device then rejects: no trust.
  const refusing = await makeDevice(n);
  const refused = await refusing.pair(n.node.pairing, endpoints, undefined, {
    operatorFirst: true,
    deviceDecision: 'reject',
  });
  assert.equal(refused.confirmed.body.state, 'rejected');
  assert.equal(n.node.pairing.pairings.length, 0);
  assert.equal((await refusing.request('GET', '/v1/info')).status, 403);

  // The device accepts first; the operator then rejects: no trust.
  const rejected = await makeDevice(n);
  const no = await rejected.pair(n.node.pairing, endpoints, () => 'reject');
  assert.equal(no.confirmed.body.state, 'rejected');
  assert.equal(n.node.pairing.pairings.length, 0);

  // Both accept, in either order: one record each.
  const first = await makeDevice(n);
  const a = await first.pair(n.node.pairing, endpoints, undefined, {
    operatorFirst: true,
  });
  assert.equal(a.confirmed.body.state, 'paired');
  const second = await makeDevice(n);
  const b = await second.pair(n.node.pairing, endpoints);
  assert.equal(b.confirmed.body.state, 'paired');
  assert.equal(n.node.pairing.pairings.length, 2);
  assert.equal((await first.request('GET', '/v1/info')).status, 200);
});

test('a job streams accepted, progress, one partial, and one valid completed', async t => {
  const { node, device } = await paired();
  t.after(() => node.close());
  for (const name of [
    'written',
    'voice',
    'mixed',
    'corrected',
    'unicode',
    'summaryOnly',
    'max',
  ]) {
    const { submitted, stream } = await run(device, fixtures[name]);
    assert.equal(stream.status, 101);
    const ev = stream.events;
    assert.deepEqual(
      ev.map(e => e.sequence),
      ev.map((_, i) => i + 1),
      name,
    );
    assert.ok(ev.length <= 64);
    assert.equal(ev[0].type, 'accepted');
    assert.deepEqual(ev[0].data, {});
    const terminal = ev.filter(e =>
      ['completed', 'failed', 'cancelled'].includes(e.type),
    );
    assert.equal(terminal.length, 1, name);
    assert.equal(ev.at(-1).type, 'completed', name);
    assert.equal(ev.filter(e => e.type === 'partial').length, 1);
    for (const e of ev) assert.ok(Object.keys(e.data).length <= 8);
    for (const f of stream.frames)
      assert.ok(
        f.fin && !f.masked && f.length <= 65_535 && f.length <= MESSAGE_CAP,
      );
    assert.equal(
      resultViolation(
        Buffer.from(canonical(ev.at(-1).data.output)),
        fixtures[name],
      ),
      null,
      name,
    );
    const status = await device.request(
      'GET',
      `/v1/jobs/${submitted.body.jobId}`,
    );
    assert.equal(status.body.state, 'completed');
    assert.deepEqual(status.body.output, ev.at(-1).data.output);
  }
});

test('idempotency: replay returns the same job, a changed body conflicts', async t => {
  const { node, device } = await paired();
  t.after(() => node.close());
  const body = job(fixtures.voice);
  const first = await device.request('POST', '/v1/jobs', body);
  const replay = await device.request('POST', '/v1/jobs', body);
  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.jobId, first.body.jobId);
  const changed = await device.request('POST', '/v1/jobs', {
    ...body,
    deadlineMs: 59_999,
  });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, 'IDEMPOTENCY_CONFLICT');
  // A second paired device has its own scope: the same key is a new job.
  const other = await makeDevice({
    nodeKey: node.pairing.identity.nodeKey,
    port: node.port,
  });
  await other.pair(node.pairing, [{ host: '127.0.0.1', port: node.port }]);
  const otherJob = await other.request('POST', '/v1/jobs', body);
  assert.equal(otherJob.status, 201);
  assert.notEqual(otherJob.body.jobId, first.body.jobId);
  const peek = await other.request('GET', `/v1/jobs/${first.body.jobId}`);
  assert.equal(peek.status, 404);
  assert.equal(peek.body.code, 'JOB_NOT_RETAINED');
});

test('request key: the same request replays its result; a reused key with other input fails', async t => {
  const { node, device } = await paired();
  t.after(() => node.close());
  const a = await run(device, fixtures.mixed);
  const b = await run(device, fixtures.mixed);
  assert.deepEqual(b.stream.events.at(-1), {
    ...a.stream.events.at(-1),
    sequence: b.stream.events.at(-1).sequence,
  });
  const tampered = structuredClone(fixtures.mixed);
  tampered.timeZone = 'UTC'; // same requestKey, different canonical input
  const c = await run(device, tampered);
  assert.equal(c.stream.events.at(-1).type, 'failed');
  assert.equal(c.stream.events.at(-1).data.code, 'EXECUTION_FAILED');
});

test('invalid inputs fail with SCHEMA_VALIDATION_FAILED and no output', async t => {
  const { node, device } = await paired();
  t.after(() => node.close());
  let n = 0;
  const cases = inputs.filter(
    x => !x.expect.valid && x.input && Object.keys(x.input).length <= 32,
  );
  for (const c of cases) {
    const r = await device.request('POST', '/v1/jobs', job(c.input));
    if (r.status === 201) {
      const s = await device.events(r.body.jobId);
      assert.equal(s.events.at(-1).type, 'failed', c.name);
      assert.equal(
        s.events.at(-1).data.code,
        'SCHEMA_VALIDATION_FAILED',
        c.name,
      );
      assert.ok(!s.events.some(e => e.type === 'completed'));
    } else {
      assert.equal(r.status, 400, c.name);
    }
    n += 1;
  }
  assert.equal(n, cases.length);
  assert.equal(n, 28); // the other two invalid cases are raw text, covered by wire rules
});

test('wire rules: strict JSON, deadline range, unknown capability, body size', async t => {
  const { node, device } = await paired();
  t.after(() => node.close());
  const body = job(fixtures.voice);
  const dup = canonical(body).replace(
    '"deadlineMs":',
    '"deadlineMs":60000,"deadlineMs":',
  );
  assert.equal(
    (
      await device.request('POST', '/v1/jobs', undefined, {
        raw: Buffer.from(dup),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await device.request('POST', '/v1/jobs', undefined, {
        raw: Buffer.from(`${canonical(body)} x`),
      })
    ).status,
    400,
  );
  for (const deadlineMs of [0, 120_001, 1.5]) {
    const r = await device.request('POST', '/v1/jobs', { ...body, deadlineMs });
    assert.equal(r.status, 400, String(deadlineMs));
    assert.equal(r.body.code, 'SCHEMA_VALIDATION_FAILED');
  }
  for (const deadlineMs of [1, 120_000]) {
    assert.equal(
      (
        await device.request(
          'POST',
          '/v1/jobs',
          job(fixtures.voice, { deadlineMs }),
        )
      ).status,
      201,
    );
  }
  const unknown = await device.request('POST', '/v1/jobs', {
    ...body,
    idempotencyKey: 'k'.repeat(20),
    capability: { id: 'document.analyze', version: '1.0.0' },
  });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, 'CAPABILITY_NOT_FOUND');
  const extra = await device.request('POST', '/v1/jobs', {
    ...body,
    idempotencyKey: 'm'.repeat(20),
    extra: true,
  });
  assert.equal(extra.status, 400);
  const huge = await device.request('POST', '/v1/jobs', undefined, {
    raw: Buffer.alloc(70_000, 0x20),
  });
  assert.equal(huge.status, 413);
});

test('cancellation and deadline end a running job once', async t => {
  const { node, device } = await paired({ stageDelayMs: 150 });
  t.after(() => node.close());
  const r = await device.request('POST', '/v1/jobs', job(fixtures.mixed));
  const streaming = device.events(r.body.jobId);
  await new Promise(res => setTimeout(res, 100));
  const cancel = await device.request('DELETE', `/v1/jobs/${r.body.jobId}`);
  assert.deepEqual(cancel.body, { jobId: r.body.jobId, state: 'cancelled' });
  const again = await device.request('DELETE', `/v1/jobs/${r.body.jobId}`);
  assert.deepEqual(again.body, { jobId: r.body.jobId, state: 'cancelled' });
  const s = await streaming;
  assert.equal(s.events.at(-1).type, 'cancelled');
  assert.equal(
    s.events.filter(e => ['completed', 'failed', 'cancelled'].includes(e.type))
      .length,
    1,
  );

  const d = await device.request(
    'POST',
    '/v1/jobs',
    job(fixtures.mixed, { deadlineMs: 200 }),
  );
  const ds = await device.events(d.body.jobId);
  assert.equal(ds.events.at(-1).type, 'failed');
  assert.equal(ds.events.at(-1).data.code, 'DEADLINE_EXCEEDED');
});

test('a lost stream resumes after a sequence', async t => {
  const { node, device } = await paired();
  t.after(() => node.close());
  const { submitted, stream } = await run(device, fixtures.voice);
  const resumed = await device.events(submitted.body.jobId, 3);
  assert.deepEqual(resumed.events, stream.events.slice(3));
  assert.equal(resumed.closeCode, 1000);
});

test('revocation: DELETE /v1/pairing/self ends access', async t => {
  const { node, device } = await paired();
  t.after(() => node.close());
  const r = await device.request('DELETE', '/v1/pairing/self');
  assert.equal(r.body.state, 'revoked');
  assert.equal((await device.request('GET', '/v1/info')).status, 403);
});
