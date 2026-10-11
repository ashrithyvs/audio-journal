#!/usr/bin/env node
// AJ-2 organize performance suite: journal.organize@1 end to end through the
// app's developer Organize benchmark, the packaged Hybrid AI SDK (public API
// only), and the Audio Journal node companion over `adb reverse`.
//
//   ANDROID_SERIAL=emulator-5554 node e2e/aj2/organize-perf.mjs --apk <app.apk>
//     [--out <dir>] [--warm 20] [--only v30s,v1m,...]
//
// For every measured fixture: one cold run (app process and companion
// restarted, so a new SDK connection, TLS handshake, and JS runtime), then
// `--warm` runs on the same connection. Then:
// - typed refusals: input cap + 1, 30 min, and 60 min in the app's builder,
//   and cap + 1 sent straight to the SDK;
// - cancellation, with the node slowed;
// - deadline, with the node too slow for 60 s.
//
// The app logs one AJ_ORGANIZE_PERF line per run (sizes, codes, durations).
// The harness adds app-process CPU and RSS from /proc, and the companion's
// own CPU, RSS, wire bytes, and per-job times.
//
// Emulator figures are development baselines, not product numbers; the
// accepted matrix is repeated on physical Android hardware later (AJ-4).
// This suite is separate from the transcription benchmarks (aj-speech) and
// the SDK capability load lab (aj-load).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  openSettingsHome,
  pairWithNode,
  setupPin,
  unlockIfNeeded,
} from '../android/lib/app.mjs';
import * as d from '../android/lib/device.mjs';
import { startCompanion } from './lib/companion.mjs';

const { values: args } = parseArgs({
  options: {
    apk: { type: 'string' },
    out: {
      type: 'string',
      default: fs.mkdtempSync(path.join(os.tmpdir(), 'aj2-perf-')),
    },
    fixture: {
      type: 'string',
      default: path.resolve(
        import.meta.dirname,
        '../../../audio-journal/e2e/android/nsd-fixture/build/outputs/apk/debug/aj-nsd-fixture-debug.apk',
      ),
    },
    warm: { type: 'string', default: '20' },
    only: { type: 'string', default: '' },
  },
});
if (!process.env.ANDROID_SERIAL) {
  throw new Error('ANDROID_SERIAL must name the device under test');
}
if (!args.apk) throw new Error('--apk is required');
fs.mkdirSync(args.out, { recursive: true });

const WARM = Number(args.warm);
const MEASURED = ['v30s', 'v1m', 'v3m', 'v5m', 'v10m', 'cap'];
const REFUSED = ['over', 'v30m', 'v60m'];
const only = new Set(args.only.split(',').filter(Boolean));
const wanted = id => only.size === 0 || only.has(id);

const NODE_NAME = 'AJ Companion';
const blocks = [];
let node;
let instance = 0;

// ------------------------------------------------------------------ helpers

async function stopNode() {
  await node.stop();
  instance += 1;
  fs.writeFileSync(
    path.join(args.out, `companion-${instance}.log`),
    node.log.join(''),
  );
}

async function restartNode(options = {}) {
  const { stateDir, port } = node;
  await stopNode();
  node = await startCompanion({ name: NODE_NAME, stateDir, port, ...options });
}

function jobLog() {
  return node.log
    .join('')
    .split('\n')
    .filter(line => line.includes('"job-ended"'))
    .map(line => JSON.parse(line));
}

function appPid() {
  return d.shell('pidof', d.PACKAGE).trim().split(/\s+/)[0];
}

function cpuMs(pid) {
  const fields = d.shell('cat', `/proc/${pid}/stat`).split(') ')[1].split(' ');
  return (Number(fields[11]) + Number(fields[12])) * 10; // 100 Hz ticks
}

function memKb(pid) {
  const text = d.shell('cat', `/proc/${pid}/status`);
  const kb = key => Number(new RegExp(`${key}:\\s+(\\d+)`).exec(text)?.[1]);
  return { rssKb: kb('VmRSS'), hwmKb: kb('VmHWM') };
}

function perfLines() {
  return d
    .adb('logcat', '-d', '-s', 'ReactNativeJS:*')
    .split('\n')
    .map(line =>
      /(AJ_ORGANIZE_PERF(?:_START|_DONE|_ERROR)?) (\{.*\})/.exec(line),
    )
    .filter(Boolean)
    .map(([, kind, json]) => ({ kind, payload: JSON.parse(json) }));
}

async function openBench() {
  await openSettingsHome();
  await d.tap({ id: 'open-diagnostics' });
  await d.tap({ id: 'open-organize-bench' });
  await d.waitFor({ id: 'bench-status' });
}

async function setCount(n) {
  await d.clearField({ id: 'bench-count' });
  await d.typeInto({ id: 'bench-count' }, String(n));
  await d.hideKeyboard();
}

async function waitDone(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = d.textOf({ id: 'bench-status' }) ?? '';
    if (new RegExp(`^(done|stopped|error) ${id}$`).test(text)) return text;
    await d.sleep(1_000);
  }
  throw new Error(`benchmark ${id} did not finish`);
}

/** Runs one block of `runs` samples and collects every measurement. */
async function block(id, runs, { label, timeoutMs = 600_000, notes } = {}) {
  d.adb('logcat', '-c');
  await setCount(runs);
  const pid = appPid();
  const before = {
    cpuMs: cpuMs(pid),
    companion: await node.stats(),
    jobs: jobLog().length,
  };
  let peakRssKb = memKb(pid).rssKb;
  const sampler = setInterval(() => {
    try {
      peakRssKb = Math.max(peakRssKb, memKb(pid).rssKb);
    } catch {
      // the process is between samples
    }
  }, 1_000);
  const started = Date.now();
  await d.tap({ id: `bench-run-${id}` });
  const status = await waitDone(id, timeoutMs);
  const wallMs = Date.now() - started;
  clearInterval(sampler);
  await d.sleep(1_500); // let the last log line and job record land
  const after = {
    cpuMs: cpuMs(pid),
    companion: await node.stats(),
    mem: memKb(pid),
  };
  const lines = perfLines();
  const samples = lines
    .filter(l => l.kind === 'AJ_ORGANIZE_PERF')
    .map(l => l.payload);
  const start = lines.find(l => l.kind === 'AJ_ORGANIZE_PERF_START')?.payload;
  const errors = lines
    .filter(l => l.kind === 'AJ_ORGANIZE_PERF_ERROR')
    .map(l => l.payload);
  const result = {
    id,
    label,
    status,
    runs,
    wallMs,
    fixture: start,
    samples,
    errors,
    nodeJobs: jobLog().slice(before.jobs),
    app: {
      cpuMs: after.cpuMs - before.cpuMs,
      peakRssKb,
      hwmKb: after.mem.hwmKb,
    },
    companion: {
      cpuMs:
        after.companion.process.cpuUserMs +
        after.companion.process.cpuSystemMs -
        before.companion.process.cpuUserMs -
        before.companion.process.cpuSystemMs,
      rssBytes: after.companion.process.rssBytes,
      maxRssKb: after.companion.process.maxRssKb,
      wireBytesIn:
        after.companion.wire.bytesRead - before.companion.wire.bytesRead,
      wireBytesOut:
        after.companion.wire.bytesWritten - before.companion.wire.bytesWritten,
      jobsAccepted: after.companion.jobs - before.companion.jobs,
    },
    notes,
  };
  blocks.push(result);
  fs.writeFileSync(
    path.join(args.out, 'blocks.json'),
    `${JSON.stringify(blocks, null, 2)}\n`,
  );
  process.stdout.write(
    `${label ?? id}: ${
      samples.length
    }/${runs} samples, ${status}, ${wallMs} ms\n`,
  );
  return result;
}

async function cold(id) {
  d.forceStop();
  await restartNode();
  d.launch();
  await unlockIfNeeded();
  await openBench();
  return block(id, 1, { label: `${id} cold` });
}

// ------------------------------------------------------------------ stats

function stats(values) {
  const v = values.filter(x => typeof x === 'number').sort((a, b) => a - b);
  if (v.length === 0) return undefined;
  const at = q => v[Math.min(v.length - 1, Math.ceil(q * v.length) - 1)];
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd =
    v.length > 1
      ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1))
      : 0;
  const round = x => Math.round(x * 10) / 10;
  return {
    n: v.length,
    min: round(v[0]),
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(v.at(-1)),
    mean: round(mean),
    sd: round(sd),
    cv: mean ? round((sd / mean) * 100) / 100 : 0,
  };
}

const METRICS = [
  'buildMs',
  'acceptedMs',
  'firstProgressMs',
  'firstPartialMs',
  'terminalMs',
  'validateMs',
  'persistMs',
  'visibleMs',
  'cancelLatencyMs',
  'deadlineOverrunMs',
];

function summarize(b) {
  const outcomes = {};
  for (const s of b.samples) {
    const key = s.code ? `${s.outcome}:${s.code}` : s.outcome;
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  }
  const metrics = {};
  for (const m of METRICS) {
    const s = stats(b.samples.map(x => x[m]));
    if (s) metrics[m] = s;
  }
  metrics.nodeJobMs = stats(b.nodeJobs.map(j => j.ms));
  metrics.nodeEngineMs = stats(b.nodeJobs.map(j => j.engineMs));
  const sent = b.samples.filter(s => s.outcome !== 'refused').length || 1;
  return {
    id: b.id,
    label: b.label,
    runs: b.samples.length,
    outcomes,
    words: b.fixture?.words,
    segments: b.fixture?.segments,
    inputBytes: b.fixture?.inputBytes,
    outputBytes: stats(b.samples.map(s => s.outputBytes))?.p50,
    // Contract §3.2: how many results were explicitly partial.
    partialResults: b.samples.filter(s => s.completeness === 'partial').length,
    omittedItems: stats(b.samples.map(s => s.omittedItems))?.p50,
    metrics,
    app: b.app,
    companion: {
      ...b.companion,
      wireBytesInPerRun: Math.round(b.companion.wireBytesIn / sent),
      wireBytesOutPerRun: Math.round(b.companion.wireBytesOut / sent),
    },
    notes: b.notes,
  };
}

// ------------------------------------------------------------------ run

let failure;
try {
  if (fs.existsSync(args.fixture)) d.adb('install', '-r', args.fixture);
  d.adb('install', '-r', args.apk);
  d.shell('pm', 'clear', d.PACKAGE);
  d.prepareDeviceLog();
  d.launch();
  await d.waitFor({ text: 'Create your private space' }, { timeoutMs: 90_000 });
  await setupPin();
  node = await startCompanion({ name: NODE_NAME });
  await pairWithNode(node);
  await openBench();

  for (const id of MEASURED.filter(wanted)) {
    await cold(id);
    await block(id, WARM, { label: `${id} warm` });
  }
  for (const id of REFUSED.filter(wanted)) {
    await block(id, 5, { label: `${id} refused` });
  }
  if (wanted('sdk-over')) {
    await block('sdk-over', 5, { label: 'sdk-over rejected by the SDK' });
  }
  if (wanted('cancel')) {
    await restartNode({ stageDelayMs: 2_000 });
    await openBench();
    await block('cancel', 5, {
      label: 'cancel',
      notes: 'node stages slowed to 2 s; cancel 300 ms after first progress',
    });
  }
  if (wanted('timeout')) {
    await restartNode({ stageDelayMs: 25_000 });
    await openBench();
    await block('timeout', 3, {
      label: 'timeout',
      timeoutMs: 400_000,
      notes: 'node stages slowed to 25 s; deadline 60 s',
    });
  }
} catch (error) {
  failure = String(error.message).split('\n').slice(0, 3).join(' / ');
  process.stdout.write(`FAIL ${failure}\n`);
} finally {
  if (node) await stopNode();
  const summary = blocks.map(summarize);
  const report = {
    suite:
      'AJ-2 organize performance: deterministic aj.rules baseline (development; protocol and SDK overhead, not model inference)',
    apk: args.apk,
    serial: process.env.ANDROID_SERIAL,
    api: d.apiLevel(),
    model: d.shell('getprop', 'ro.product.model').trim(),
    host: { cpus: os.cpus().length, model: os.cpus()[0]?.model },
    warmRuns: WARM,
    finishedAt: new Date().toISOString(),
    failure,
    summary,
  };
  fs.writeFileSync(
    path.join(args.out, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  process.stdout.write(`report in ${args.out}\n`);
  process.exitCode = failure ? 1 : 0;
}
