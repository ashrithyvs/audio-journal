#!/usr/bin/env node
// Real-speech load and accuracy run through the Audio Journal app on Android.
//
//   node e2e/android/aj-speech.mjs [--apk <release.apk>] [--model base.en-q5_1]
//        [--suite smoke|standard|noise|long|full] [--concurrency 1] [--threads 4]
//        [--sdk-stage none|local|node|auto] [--soak-minutes 0] [--cancel-probes 0]
//        [--fresh] [--out <dir>]
//
// The app transcribes on-device with its own whisper.cpp engine (ADR-016) and,
// when --sdk-stage is set, hands only the transcript text to Hybrid AI through
// the packaged SDK's public API. This harness pushes the verified dataset into
// the app's development `speech-eval` directory, drives the Load lab, samples
// memory/CPU/thermal state, pulls the per-file results, re-scores them on the
// host as an independent cross-check, and writes summary.json + summary.md.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  aggregate,
  groupBy,
  percentiles,
  scoreUtterance,
} from '../speech/lib/metrics.mjs';
import { suiteItems } from '../speech/lib/suites.mjs';
import {
  openLoadLab,
  pairWithNode,
  setupPin,
  unlockIfNeeded,
} from './lib/app.mjs';
import * as d from './lib/device.mjs';
import { startNode } from './lib/node.mjs';
import { memory, startSampler } from './lib/sampler.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const { values: args } = parseArgs({
  options: {
    apk: { type: 'string' },
    model: { type: 'string', default: 'base.en-q5_1' },
    suite: { type: 'string', default: 'smoke' },
    concurrency: { type: 'string', default: '1' },
    threads: { type: 'string', default: '4' },
    'sdk-stage': { type: 'string', default: 'none' },
    'soak-minutes': { type: 'string' },
    'cancel-probes': { type: 'string', default: '0' },
    limit: { type: 'string' },
    fresh: { type: 'boolean', default: false },
    dataset: {
      type: 'string',
      default: path.join(here, '../speech/.cache/dataset'),
    },
    out: { type: 'string' },
  },
});
const runId = `run-${Date.now()}`;
const out =
  args.out ??
  path.join(
    here,
    '../speech/results',
    `app-${args.model}-${args.suite}-c${args.concurrency}-${args['sdk-stage']}-${runId}`,
  );
fs.mkdirSync(out, { recursive: true });
const EVAL = `/sdcard/Android/data/${d.PACKAGE}/files/speech-eval`;

const manifest = JSON.parse(
  fs.readFileSync(path.join(args.dataset, 'manifest.json'), 'utf8'),
);
const items = suiteItems(manifest, args.suite).slice(0, args.limit ? Number(args.limit) : undefined);
const audioSec = items.reduce((sum, item) => sum + item.durationSec, 0);
const soakMinutes =
  args['soak-minutes'] === undefined ? undefined : Number(args['soak-minutes']);
// Generous ceiling: emulator RTF can exceed 1 for base models under load.
const timeoutMs = Math.max(
  10 * 60_000,
  (soakMinutes ?? 0) * 60_000 + audioSec * 3_000,
);

function logLines(kind) {
  return d
    .adb('logcat', '-d', '-s', 'ReactNativeJS:*')
    .split('\n')
    .map(line => new RegExp(`(${kind}) (\\{.*\\})`).exec(line))
    .filter(Boolean)
    .map(match => JSON.parse(match[2]));
}

const report = {
  startedAt: new Date().toISOString(),
  runId,
  apk: args.apk,
  engine: {
    name: 'whisper.cpp',
    release: 'v1.9.5',
    commit: 'd1be6fde',
    inApp: true,
    model: args.model,
    threads: Number(args.threads),
  },
  plan: {
    suite: args.suite,
    files: items.length,
    audioMinutes: Math.round((audioSec / 60) * 100) / 100,
    concurrency: Number(args.concurrency),
    sdkStage: args['sdk-stage'],
    soakMinutes,
    cancelProbes: Number(args['cancel-probes']),
  },
  dataset: { license: manifest.license, sources: manifest.sources },
  failures: [],
};
let node;

try {
  report.device = {
    api: d.apiLevel(),
    model: d.shell('getprop', 'ro.product.model').trim(),
    abi: d.shell('getprop', 'ro.product.cpu.abi').trim(),
    emulator: d.shell('getprop', 'ro.kernel.qemu').trim() === '1',
    cores: Number(d.shell('nproc').trim()),
  };
  if (args.apk) d.adb('install', '-r', args.apk);
  if (args.fresh) {
    d.forceStop();
    d.shell('pm', 'clear', d.PACKAGE);
  }
  d.quietKeyboard();
  d.launch();
  await unlockIfNeeded().catch(async () => setupPin());

  if (args['sdk-stage'] === 'node' || args['sdk-stage'] === 'auto') {
    node = await startNode({ name: 'AJ Speech Node' });
    await pairWithNode(node);
  }
  await openLoadLab();

  // Stage fixtures: audio for this suite, verified on the device, plus the plan.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'aj-speech-push-'));
  for (const item of items) {
    const target = path.join(staging, 'audio', item.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(args.dataset, item.file), target);
  }
  const plan = {
    runId,
    model: args.model,
    threads: Number(args.threads),
    concurrency: Number(args.concurrency),
    sdkStage: args['sdk-stage'],
    soakMinutes,
    cancelProbes: Number(args['cancel-probes']),
    items: items.map(item => ({
      file: item.file,
      reference: item.reference,
      durationSec: item.durationSec,
      condition: item.condition,
      set: item.set,
      gender: item.gender,
    })),
  };
  fs.writeFileSync(path.join(staging, 'plan.json'), JSON.stringify(plan));
  d.shell('rm', '-rf', `${EVAL}/audio`, `${EVAL}/results`, `${EVAL}/plan.json`);
  d.adb('push', `${staging}/.`, EVAL);
  fs.rmSync(staging, { recursive: true, force: true });
  const remote = new Map(
    d
      .shell(`cd ${EVAL}/audio && find . -name '*.wav' -exec sha256sum {} +`)
      .trim()
      .split('\n')
      .map(line => line.trim().split(/\s+/))
      .map(([sha, file]) => [file.replace(/^\.\//, ''), sha]),
  );
  const bad = items.filter(item => remote.get(item.file) !== item.sha256);
  if (bad.length)
    throw new Error(`audio integrity failed on device for ${bad.length} files`);
  report.inputIntegrity = { verifiedOnDevice: items.length };
  console.log(
    `pushed and verified ${items.length} files (${report.plan.audioMinutes} min)`,
  );

  d.adb('logcat', '-c');
  report.idleBefore = memory();
  const sampler = startSampler('speech', 5_000);
  const started = Date.now();
  const button =
    d.find(d.dump(), { id: 'load-run-speech' }) ??
    (await d.scrollTo({ id: 'load-run-speech' }));
  if (!button.enabled)
    throw new Error(
      'speech engine unavailable in the app (Run speech plan is disabled)',
    );
  await d.tap({ id: 'load-run-speech' });
  let done;
  while (!done && Date.now() - started < timeoutMs) {
    await d.sleep(10_000);
    done = logLines('AJ_SPEECH_DONE')[0];
    const progress = logLines('AJ_SPEECH_PROGRESS').at(-1);
    if (progress)
      process.stdout.write(`  ${progress.done}/${progress.total}\n`);
  }
  report.resources = sampler.stop();
  report.harnessWallSec = Math.round((Date.now() - started) / 1000);
  if (!done)
    throw new Error(
      `speech plan did not finish in ${Math.round(timeoutMs / 60_000)} min`,
    );
  if (done.error) throw new Error(`app reported ${done.error}`);
  report.appSummary = done;
  report.idleAfter = memory();

  // Pull per-file results and re-score independently on the host.
  const pulled = path.join(out, 'results.jsonl');
  d.adb('pull', `${EVAL}/results/${runId}.jsonl`, pulled);
  const byFile = new Map(items.map(item => [item.file, item]));
  const results = fs
    .readFileSync(pulled, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
    .map(result => {
      const item = byFile.get(result.file);
      const record = {
        ...result,
        status: result.status === 'ok' ? 'ok' : result.status,
        speakerId: item.speakerId,
        inferenceMs: result.timings?.inferenceMs ?? 0,
        wallMs: result.timings?.totalMs ?? 0,
        peakRssKb: result.memory?.vmHwmKb,
      };
      if (result.status === 'ok') {
        record.score = scoreUtterance(item.reference, result.hypothesis);
        // Cross-check: in-app and host scorers must agree exactly.
        if (record.score.word.errors !== result.words?.errors)
          record.scoreMismatch = true;
      }
      return record;
    });
  report.crossCheck = {
    files: results.length,
    scoreMismatches: results.filter(result => result.scoreMismatch).length,
  };
  report.overall = aggregate(results);
  report.byCondition = groupBy(
    results,
    result => `${result.set}/${result.condition}`,
  );
  report.byGender = groupBy(
    results.filter(result => ['M', 'F'].includes(result.gender)),
    result => result.gender,
  );
  report.byPass =
    report.appSummary.passes > 1
      ? groupBy(results, result => `pass${result.pass}`)
      : undefined;
  report.firstSegmentMs = percentiles(
    results.flatMap(result =>
      result.firstSegmentMs ? [result.firstSegmentMs] : [],
    ),
  );
  const handoffs = results.flatMap(result => (result.sdk ? [result.sdk] : []));
  if (handoffs.length) {
    const count = predicate => handoffs.filter(predicate).length;
    report.sdkHandoff = {
      requests: handoffs.length,
      completed: count(h => h.outcome === 'completed'),
      valid: count(h => h.valid),
      grounded: count(h => h.grounded),
      targets: groupCounts(handoffs.map(h => h.target ?? 'none')),
      routingReasons: groupCounts(handoffs.map(h => h.routingReason ?? 'none')),
      codes: groupCounts(handoffs.flatMap(h => (h.code ? [h.code] : []))),
      latencyMs: percentiles(handoffs.map(h => h.latencyMs)),
    };
  }
  report.spotChecks = results
    .filter(
      (result, index) =>
        result.status === 'ok' &&
        index % Math.max(1, Math.floor(results.length / 6)) === 0,
    )
    .slice(0, 6)
    .map(result => ({
      file: result.file,
      wer: Math.round(result.score.wer * 1000) / 1000,
      reference: byFile.get(result.file).reference,
      hypothesis: result.hypothesis,
    }));
  report.worstFiles = results
    .filter(result => result.status === 'ok')
    .sort((a, b) => b.score.wer - a.score.wer)
    .slice(0, 8)
    .map(result => ({
      file: result.file,
      wer: Math.round(result.score.wer * 1000) / 1000,
    }));

  // Privacy: transcripts must never reach the device log.
  const log = d.adb('logcat', '-d');
  const leaked = results.filter(
    result =>
      result.hypothesis?.length > 30 &&
      log.includes(result.hypothesis.slice(0, 30)),
  );
  report.privacy = { transcriptsInLogcat: leaked.length };
  if (leaked.length)
    report.failures.push(`${leaked.length} transcripts found in logcat`);
  if (report.crossCheck.scoreMismatches)
    report.failures.push('in-app and host WER disagree');
  if (report.overall.failed)
    report.failures.push(`${report.overall.failed} transcriptions failed`);
  if (d.shell('pidof', d.PACKAGE).trim() === '')
    report.failures.push('app process died');
} catch (error) {
  report.failures.push(String(error.message ?? error));
} finally {
  if (node) await node.stop();
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(out, 'summary.json'),
    JSON.stringify(report, null, 2),
  );
  fs.writeFileSync(path.join(out, 'summary.md'), markdown(report));
  console.log(markdown(report));
  console.log(`report: ${out}`);
  process.exitCode = report.failures.length ? 1 : 0;
}

function groupCounts(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function pct(value) {
  return value === undefined ? '—' : `${(value * 100).toFixed(2)}%`;
}

function markdown(r) {
  const lines = [
    `# Speech run ${r.runId}`,
    '',
    `- Device: ${r.device?.model} API ${r.device?.api} ${r.device?.abi}${
      r.device?.emulator ? ' (emulator)' : ''
    }, ${r.device?.cores} cores`,
    `- Engine: in-app whisper.cpp ${r.engine.release}, model ${r.engine.model}, ${r.engine.threads} threads, greedy`,
    `- Plan: ${r.plan.suite}, ${r.plan.files} files, ${r.plan.audioMinutes} min audio, concurrency ${r.plan.concurrency}, SDK stage ${r.plan.sdkStage}`,
    `- Input integrity: ${
      r.inputIntegrity?.verifiedOnDevice ?? 0
    } files SHA-256-verified on device`,
    `- Failures: ${r.failures.length ? r.failures.join('; ') : 'none'}`,
  ];
  if (r.overall) {
    const o = r.overall;
    lines.push(
      '',
      '| Metric | Value |',
      '|---|---|',
      `| Files ok / failed | ${o.files - o.failed} / ${o.failed} |`,
      `| Corpus WER / CER | ${pct(o.wer)} / ${pct(o.cer)} |`,
      `| S / D / I | ${o.substitutions} / ${o.deletions} / ${o.insertions} of ${o.referenceWords} words |`,
      `| Real-time factor (corpus) | ${o.realTimeFactor} |`,
      `| RTF p50 / p95 / max | ${o.rtf?.p50} / ${o.rtf?.p95} / ${o.rtf?.max} |`,
      `| First segment p50 / p95 ms | ${r.firstSegmentMs?.p50} / ${r.firstSegmentMs?.p95} |`,
      `| Inference p50 / p95 ms | ${o.inferenceMs?.p50} / ${o.inferenceMs?.p95} |`,
      `| Cancel latency p50 ms | ${
        r.appSummary?.cancelLatencyMs?.p50 ?? '—'
      } |`,
      `| Process peak RSS (VmHWM) | ${Math.round(
        (r.appSummary?.peakRssKb ?? 0) / 1024,
      )} MB |`,
      `| PSS max / CPU mean % / thermal max | ${Math.round(
        (r.resources?.pssKb?.max ?? 0) / 1024,
      )} MB / ${r.resources?.cpuPercent?.mean} / ${r.resources?.thermalMax} |`,
      `| Wall time | ${r.harnessWallSec} s |`,
      `| In-app vs host WER mismatches | ${r.crossCheck?.scoreMismatches} |`,
      `| Transcripts found in logcat | ${r.privacy?.transcriptsInLogcat} |`,
      '',
      '| Condition | Files | WER | RTF |',
      '|---|---|---|---|',
      ...Object.entries(r.byCondition).map(
        ([name, g]) =>
          `| ${name} | ${g.files} | ${pct(g.wer)} | ${g.realTimeFactor} |`,
      ),
    );
    if (r.byGender) {
      lines.push('', '| Speaker gender | Files | WER |', '|---|---|---|');
      for (const [name, g] of Object.entries(r.byGender))
        lines.push(`| ${name} | ${g.files} | ${pct(g.wer)} |`);
    }
  }
  if (r.sdkHandoff) {
    const h = r.sdkHandoff;
    lines.push(
      '',
      `SDK text handoff: ${h.completed}/${h.requests} completed, ${
        h.valid
      } schema-valid, ${h.grounded} grounded; targets ${JSON.stringify(
        h.targets,
      )}; reasons ${JSON.stringify(h.routingReasons)}; codes ${JSON.stringify(
        h.codes,
      )}; latency p50 ${h.latencyMs?.p50} ms p95 ${h.latencyMs?.p95} ms`,
    );
  }
  return `${lines.join('\n')}\n`;
}
