// Development load run for the companion (not a budget): K paired devices
// submit J organize jobs each over TLS, C at a time, and stream every job's
// events to its terminal. Reports latency percentiles (submit to terminal),
// throughput, event counts, failures, and RSS. Run it inside the
// exclusive-run window; nothing else should load the host.
//
//   node scripts/load.mjs [--devices 4] [--jobs 50] [--concurrency 8] [--fixture max]

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { loadIdentity } from '../src/identity.mjs';
import { startCompanion } from '../src/server.mjs';
import { job, makeDevice } from '../test/device.mjs';

const { values } = parseArgs({
  options: {
    devices: { type: 'string', default: '4' },
    jobs: { type: 'string', default: '50' },
    concurrency: { type: 'string', default: '8' },
    fixture: { type: 'string', default: 'max' },
  },
});
const HERE = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(
    join(
      HERE,
      '..',
      '..',
      'schemas',
      'journal',
      'v1',
      'vectors',
      'fixtures.json',
    ),
    'utf8',
  ),
);
const input = fixtures[values.fixture];

const identity = await loadIdentity(mkdtempSync(join(tmpdir(), 'aj-load-')));
const node = await startCompanion(identity, { host: '127.0.0.1' });
const target = { nodeKey: identity.nodeKey, port: node.port };
const devices = [];
for (let i = 0; i < Number(values.devices); i += 1) {
  const d = await makeDevice(target, { name: `Load device ${i}` });
  await d.pair(node.pairing, [{ host: '127.0.0.1', port: node.port }]);
  devices.push(d);
}

const rss0 = process.memoryUsage().rss;
const latencies = [];
const failures = {};
let events = 0;
let peakRss = rss0;
const work = [];
for (const d of devices)
  for (let j = 0; j < Number(values.jobs); j += 1) work.push(d);
const started = performance.now();
async function worker() {
  for (;;) {
    const d = work.shift();
    if (!d) return;
    const t0 = performance.now();
    // A fresh request key per job, so the engine runs every time.
    const fresh = structuredClone(input);
    fresh.requestKey = `org_${Math.random()
      .toString(32)
      .slice(2)
      .padEnd(26, '0')
      .slice(0, 26)
      .replace(/[ilou]/g, '0')}`;
    const r = await d.request('POST', '/v1/jobs', job(fresh));
    const s = await d.events(r.body.jobId);
    latencies.push(performance.now() - t0);
    events += s.events.length;
    const last = s.events.at(-1);
    if (last?.type !== 'completed')
      failures[last?.data?.code ?? 'no-terminal'] =
        (failures[last?.data?.code ?? 'no-terminal'] ?? 0) + 1;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
}
await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));
const total = performance.now() - started;
latencies.sort((a, b) => a - b);
const pct = p =>
  Math.round(
    latencies[
      Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))
    ],
  );
const summary = {
  fixture: values.fixture,
  inputBytes: Buffer.byteLength(JSON.stringify(input)),
  devices: devices.length,
  jobs: latencies.length,
  concurrency: Number(values.concurrency),
  failures,
  latencyMs: {
    p50: pct(50),
    p90: pct(90),
    p99: pct(99),
    max: Math.round(latencies.at(-1)),
  },
  jobsPerSecond: Number((latencies.length / (total / 1000)).toFixed(1)),
  eventsPerJob: Number((events / latencies.length).toFixed(1)),
  rssMb: {
    start: Math.round(rss0 / 1048576),
    peak: Math.round(peakRss / 1048576),
  },
  node: process.version,
};
process.stdout.write(`AJ2_COMPANION_LOAD ${JSON.stringify(summary)}\n`);
await node.close();
process.exit(Object.keys(failures).length ? 1 : 0);
