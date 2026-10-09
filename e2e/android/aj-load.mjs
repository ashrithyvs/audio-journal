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
import { memory, startSampler } from './lib/sampler.mjs';

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
