#!/usr/bin/env node
// Hybrid AI v0.1 load and performance run through Audio Journal on Android.
//
//   node e2e/android/aj-load.mjs --apk <release.apk> [--out <dir>]
//        [--suites local,node,soak] [--launches 5]
//
// The app's Load lab issues every request through the packaged SDK's public
// API. This harness installs the app, measures cold/warm start, drives the
// lab, samples process memory, CPU, and thermal state, and collects each
// workload's AJ_LOAD result line. Exit status is non-zero on any failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { openLoadLab, pairWithNode, setupPin } from './lib/app.mjs';
import * as d from './lib/device.mjs';
import { startNode } from './lib/node.mjs';

const { values: args } = parseArgs({
  options: {
    apk: { type: 'string' },
    out: {
      type: 'string',
      default: fs.mkdtempSync(path.join(os.tmpdir(), 'aj-load-')),
    },
    suites: { type: 'string', default: 'local,node,soak' },
    launches: { type: 'string', default: '5' },
  },
});
fs.mkdirSync(args.out, { recursive: true });
const suites = args.suites.split(',');

// --- Device sampling -------------------------------------------------------------

function pid() {
  return d.shell('pidof', d.PACKAGE).trim().split(/\s+/)[0];
}

function memory() {
  const text = d.shell('dumpsys', 'meminfo', d.PACKAGE);
  const row = name => {
    const match = new RegExp(`^\\s*${name}\\s+(\\d+)`, 'm').exec(text);
    return match ? Number(match[1]) : undefined;
  };
  return {
    totalPssKb: Number(
      /TOTAL PSS:\s+(\d+)/.exec(text)?.[1] ?? /TOTAL\s+(\d+)/.exec(text)?.[1],
    ),
    totalRssKb: Number(/TOTAL RSS:\s+(\d+)/.exec(text)?.[1] ?? NaN),
    javaHeapKb: row('Java Heap:'),
    nativeHeapKb: row('Native Heap:'),
    graphicsKb: row('Graphics:'),
  };
}

function cpuTicks(processId) {
  const fields = d
    .shell('cat', `/proc/${processId}/stat`)
    .split(') ')[1]
    .split(' ');
  return Number(fields[11]) + Number(fields[12]); // utime + stime
}

function thermal() {
  const text = d.shell('dumpsys', 'thermalservice');
  return Number(/Thermal Status: (\d+)/.exec(text)?.[1] ?? NaN);
}

function battery() {
  const text = d.shell('dumpsys', 'battery');
  return {
    level: Number(/level: (\d+)/.exec(text)?.[1]),
    temperatureC: Number(/temperature: (\d+)/.exec(text)?.[1]) / 10,
  };
}

function startSampler(label, intervalMs = 3_000) {
  const samples = [];
  const processId = pid();
  let lastTicks = cpuTicks(processId);
  let lastAt = Date.now();
  const hz = 100;
  const cores = Number(d.shell('nproc').trim()) || 1;
  const timer = setInterval(() => {
    try {
      const ticks = cpuTicks(processId);
      const at = Date.now();
      const cpuPercent =
        ((ticks - lastTicks) / hz / ((at - lastAt) / 1000)) * 100;
      lastTicks = ticks;
      lastAt = at;
      samples.push({
        t: at,
        cpuPercent: Math.round(cpuPercent),
        cores,
        ...memory(),
        thermal: thermal(),
      });
    } catch {
      // the process can be between states; skip this sample
    }
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      return { label, samples, ...summarizeSamples(samples) };
    },
  };
}

function summarizeSamples(samples) {
  const pick = key =>
    samples.map(sample => sample[key]).filter(Number.isFinite);
  const stats = values =>
    values.length
      ? {
          min: Math.min(...values),
          max: Math.max(...values),
          mean: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
          first: values[0],
          last: values[values.length - 1],
        }
      : undefined;
  return {
    count: samples.length,
    pssKb: stats(pick('totalPssKb')),
    nativeHeapKb: stats(pick('nativeHeapKb')),
    javaHeapKb: stats(pick('javaHeapKb')),
    cpuPercent: stats(pick('cpuPercent')),
    thermalMax: Math.max(...pick('thermal'), 0),
  };
}

// --- Lab driving -------------------------------------------------------------------

function loadLines() {
  return d
    .adb('logcat', '-d', '-s', 'ReactNativeJS:*')
    .split('\n')
    .map(line => /(AJ_LOAD(?:_START|_DONE)?) (\{.*\})/.exec(line))
    .filter(Boolean)
    .map(([, kind, json]) => ({ kind, payload: JSON.parse(json) }));
}

async function runLab(buttonId, label, timeoutMs) {
  d.adb('logcat', '-c');
  await openLoadLab();
  const sampler = startSampler(label);
  const started = Date.now();
  await d.tap({ id: buttonId });
  let done;
  while (!done && Date.now() - started < timeoutMs) {
    await d.sleep(5_000);
    done = loadLines().find(line => line.kind === 'AJ_LOAD_DONE');
    const status = d.textOf({ id: 'load-status' });
    if (status) process.stdout.write(`  ${label}: ${status}\n`);
  }
  const resources = sampler.stop();
  const workloads = loadLines()
    .filter(line => line.kind === 'AJ_LOAD')
    .map(line => line.payload);
  if (!done) throw new Error(`${label} did not finish within ${timeoutMs} ms`);
  return {
    label,
    done: done.payload,
    workloads,
    resources,
    harnessWallMs: Date.now() - started,
  };
}

// --- Run ----------------------------------------------------------------------------

const report = {
  startedAt: new Date().toISOString(),
  device: {
    api: d.apiLevel(),
    model: d.shell('getprop', 'ro.product.model').trim(),
    abi: d.shell('getprop', 'ro.product.cpu.abi').trim(),
    cores: Number(d.shell('nproc').trim()),
    memTotalKb: Number(
      /MemTotal:\s+(\d+)/.exec(d.shell('cat', '/proc/meminfo'))?.[1],
    ),
  },
  apk: args.apk,
  runs: [],
  failures: [],
};
let node;

try {
  d.adb('install', '-r', args.apk);
  d.forceStop();
  d.shell('pm', 'clear', d.PACKAGE);
  d.quietKeyboard();

  // Startup: cold (process killed) and warm (activity relaunched from home).
  const cold = [];
  const warm = [];
  for (let index = 0; index < Number(args.launches); index += 1) {
    d.forceStop();
    await d.sleep(1_000);
    cold.push(d.launch());
    await d.waitFor({ text: 'Create your private space' });
    d.home();
    await d.sleep(1_000);
    warm.push(d.launch());
    await d.waitFor({ text: 'Create your private space' });
  }
  report.startup = { coldMs: cold, warmMs: warm };
  console.log(`startup cold ${cold.join(',')} warm ${warm.join(',')}`);

  await setupPin();
  await openLoadLab();
  report.localModels = d.textOf({ id: 'load-local-models' });
  report.idleBefore = memory();
  console.log(
    `${report.localModels}; idle PSS ${report.idleBefore.totalPssKb} kB`,
  );

  if (suites.includes('local')) {
    console.log('▶ local suite');
    report.runs.push(
      await runLab('load-run-local', 'local-suite', 40 * 60_000),
    );
  }
  if (suites.includes('node')) {
    console.log('▶ node suite');
    node = await startNode({ name: 'AJ Load Node' });
    await pairWithNode(node);
    await openLoadLab();
    await d.waitFor({ id: 'load-run-node' });
    report.runs.push(await runLab('load-run-node', 'node-suite', 20 * 60_000));
  }
  if (suites.includes('soak')) {
    console.log('▶ soak (10 min)');
    report.runs.push(await runLab('load-run-soak', 'soak', 15 * 60_000));
  }
  await d.sleep(10_000);
  report.idleAfter = memory();

  const log = d.adb('logcat', '-d');
  for (const secret of ['482915', 'hybrid-ai-pair:']) {
    if (log.includes(secret)) report.failures.push(`logcat contains ${secret}`);
  }
  if (d.shell('pidof', d.PACKAGE).trim() === '')
    report.failures.push('app process died');
} catch (error) {
  report.failures.push(String(error.message ?? error));
} finally {
  if (node) await node.stop();
  for (const run of report.runs) {
    for (const workload of run.workloads) {
      if (!workload.passed)
        report.failures.push(`${run.label} ${workload.id} failed`);
    }
  }
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(args.out, 'load-report.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({ out: args.out, failures: report.failures }, null, 2),
  );
  process.exitCode = report.failures.length ? 1 : 0;
}
