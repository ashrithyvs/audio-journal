#!/usr/bin/env node
// Real-speech accuracy, latency, and load evaluation.
//
//   node run-eval.mjs --engine device|host --model tiny.en [--suite smoke|standard|full|long]
//        [--concurrency 1] [--threads 4] [--beam 1] [--soak-minutes 0] [--serial <id>] [--out dir]
//
// Engines run a pinned whisper.cpp build (outside the Hybrid AI SDK) as the
// reference speech engine: `device` on the attached emulator or phone over
// adb, `host` on this machine. Results include corpus WER/CER, S/D/I counts,
// real-time factor, latency percentiles, peak RSS, and device thermal/memory
// samples, grouped by condition, test set, and speaker gender.
import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';

import {
  aggregate,
  groupBy,
  percentiles,
  scoreUtterance,
} from './lib/metrics.mjs';

const run = promisify(execFile);
const here = path.dirname(new URL(import.meta.url).pathname);
const { values: args } = parseArgs({
  options: {
    engine: { type: 'string', default: 'device' },
    model: { type: 'string', default: 'tiny.en' },
    suite: { type: 'string', default: 'smoke' },
    concurrency: { type: 'string', default: '1' },
    threads: { type: 'string', default: '4' },
    beam: { type: 'string', default: '1' },
    'soak-minutes': { type: 'string', default: '0' },
    serial: { type: 'string' },
    dataset: { type: 'string', default: path.join(here, '.cache/dataset') },
    whisper: { type: 'string', default: process.env.AJ_WHISPER_DIR },
    out: { type: 'string' },
  },
});

export const WHISPER = {
  release: 'v1.9.5',
  commit: 'd1be6fde11ac6e0407606b4e42fe72d34add8037',
};
export const MODELS = {
  'tiny.en': '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f',
  'tiny.en-q5_1':
    'c77c5766f1cef09b6b7d47f21b546cbddd4157886b3b5d6d4f709e91e66c7c2b',
  'base.en': 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
  'base.en-q5_1':
    '4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f',
};

const manifest = JSON.parse(
  fs.readFileSync(path.join(args.dataset, 'manifest.json'), 'utf8'),
);
const concurrency = Number(args.concurrency);
const threads = Number(args.threads);
const decoding = ['-bs', args.beam, '-bo', args.beam];
const out =
  args.out ??
  path.join(
    here,
    'results',
    `${args.engine}-${args.model}-${args.suite}-c${concurrency}-${Date.now()}`,
  );
fs.mkdirSync(out, { recursive: true });

// --- Suites -----------------------------------------------------------------------

function suiteItems(suite) {
  const items = manifest.items;
  const firstPerSpeaker = (set, condition) => {
    const seen = new Set();
    return items.filter(item => {
      if (
        item.set !== set ||
        item.condition !== condition ||
        seen.has(item.speakerId)
      )
        return false;
      seen.add(item.speakerId);
      return true;
    });
  };
  switch (suite) {
    case 'smoke':
      return firstPerSpeaker('test-clean', 'clean').slice(0, 20);
    case 'standard':
      return items.filter(
        item =>
          (item.set === 'test-clean' &&
            ['clean', 'babble10', 'quiet'].includes(item.condition)) ||
          (item.set === 'test-other' && item.condition === 'clean'),
      );
    case 'long':
      return items.filter(item => item.condition.startsWith('long'));
    case 'full':
      return items;
    default:
      throw new Error(`unknown suite ${suite}`);
  }
}

// --- Input validation -------------------------------------------------------------

/** Checks a fixture is RIFF/WAVE PCM, mono, 16 kHz, 16-bit, matching its manifest. */
export function validateWav(buffer, item) {
  const fail = reason => {
    throw new Error(`${item.file}: ${reason}`);
  };
  if (
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  )
    fail('not RIFF/WAVE');
  if (buffer.readUInt16LE(20) !== 1) fail('not PCM');
  if (buffer.readUInt16LE(22) !== 1) fail('not mono');
  if (buffer.readUInt32LE(24) !== 16_000) fail('not 16 kHz');
  if (buffer.readUInt16LE(34) !== 16) fail('not 16-bit');
  const seconds = buffer.readUInt32LE(40) / 2 / 16_000;
  if (Math.abs(seconds - item.durationSec) > 0.002)
    fail(`duration ${seconds} != ${item.durationSec}`);
  if (crypto.createHash('sha256').update(buffer).digest('hex') !== item.sha256)
    fail('SHA-256 mismatch');
}

/** Rejects malformed engine output instead of scoring it. */
export function validateOutput(json) {
  if (!json || !Array.isArray(json.transcription))
    return 'missing transcription array';
  if (json.result?.language !== 'en')
    return `language ${json.result?.language}`;
  if (json.transcription.some(segment => typeof segment.text !== 'string'))
    return 'segment without text';
  const expected = args.model.split('.')[0];
  if (json.model?.type !== expected)
    return `model type ${json.model?.type} != ${expected}`;
  return undefined;
}

// --- Engines ----------------------------------------------------------------------

const adbArgs = args.serial ? ['-s', args.serial] : [];
const adb = (...rest) =>
  execFileSync('adb', [...adbArgs, ...rest], {
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
const DEVICE_DIR = '/data/local/tmp/aj-speech';

function parseTimings(log) {
  const value = name =>
    Number(new RegExp(`${name} time =\\s+([\\d.]+) ms`).exec(log)?.[1] ?? NaN);
  return {
    loadMs: value('load'),
    encodeMs: value('encode'),
    decodeMs: value('decode'),
    totalMs: value('total'),
  };
}

function transcriptOf(json) {
  return (json.transcription ?? [])
    .map(segment => segment.text)
    .join(' ')
    .trim();
}

function deviceInfo() {
  const prop = name => adb('shell', 'getprop', name).trim();
  const cpuinfo = adb('shell', 'cat', '/proc/cpuinfo');
  return {
    model: prop('ro.product.model'),
    api: Number(prop('ro.build.version.sdk')),
    abi: prop('ro.product.cpu.abi'),
    emulator: prop('ro.kernel.qemu') === '1' || prop('ro.boot.qemu') === '1',
    cores: Number(adb('shell', 'nproc').trim()),
    memTotalKb: Number(
      /MemTotal:\s+(\d+)/.exec(adb('shell', 'cat', '/proc/meminfo'))?.[1],
    ),
    cpuFlags: (
      /flags\s*:\s*(.*)/.exec(cpuinfo)?.[1] ??
      /Features\s*:\s*(.*)/.exec(cpuinfo)?.[1] ??
      ''
    )
      .split(/\s+/)
      .filter(flag =>
        /^(sse\d?|ssse3|sse4_\d|avx\w*|fma|f16c|asimd\w*|fphp|dotprod|i8mm|sve\w*)$/.test(
          flag,
        ),
      ),
  };
}

function deviceSample() {
  const thermal = Number(
    /Thermal Status: (\d+)/.exec(
      adb('shell', 'dumpsys', 'thermalservice'),
    )?.[1] ?? NaN,
  );
  const battery = adb('shell', 'dumpsys', 'battery');
  const meminfo = adb('shell', 'cat', '/proc/meminfo');
  return {
    t: Date.now(),
    thermal,
    batteryTempC: Number(/temperature: (\d+)/.exec(battery)?.[1]) / 10,
    batteryLevel: Number(/level: (\d+)/.exec(battery)?.[1]),
    memAvailableKb: Number(/MemAvailable:\s+(\d+)/.exec(meminfo)?.[1]),
    load1: Number(adb('shell', 'cat', '/proc/loadavg').split(' ')[0]),
  };
}

async function prepareDevice(items) {
  const info = deviceInfo();
  const abi = info.abi.startsWith('arm64') ? 'arm64-v8a' : info.abi;
  const binary = path.join(args.whisper, `build-${abi}`, 'bin', 'whisper-cli');
  const model = path.join(args.whisper, 'models', `ggml-${args.model}.bin`);
  adb('shell', 'mkdir', '-p', `${DEVICE_DIR}/audio`, `${DEVICE_DIR}/out`);
  adb('push', binary, `${DEVICE_DIR}/whisper-cli`);
  adb(
    'push',
    path.join(here, 'lib/device-run.sh'),
    `${DEVICE_DIR}/device-run.sh`,
  );
  adb(
    'shell',
    'chmod',
    '755',
    `${DEVICE_DIR}/whisper-cli`,
    `${DEVICE_DIR}/device-run.sh`,
  );
  const remoteModel = `${DEVICE_DIR}/ggml-${args.model}.bin`;
  const remoteSha = () => {
    try {
      return adb('shell', 'sha256sum', remoteModel).split(' ')[0];
    } catch {
      return ''; // not on the device yet
    }
  };
  if (remoteSha() !== MODELS[args.model]) adb('push', model, remoteModel);
  if (remoteSha() !== MODELS[args.model])
    throw new Error(`model ${args.model} SHA-256 mismatch on device`);
  // Push only the audio this suite needs, preserving relative paths.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'aj-speech-'));
  for (const item of items) {
    const target = path.join(staging, item.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(args.dataset, item.file), target);
  }
  adb('shell', 'rm', '-rf', `${DEVICE_DIR}/audio`);
  adb('push', staging, `${DEVICE_DIR}/audio`);
  fs.rmSync(staging, { recursive: true, force: true });
  // Input integrity: every pushed file must hash to its manifest value.
  const remote = new Map(
    adb(
      'shell',
      `cd ${DEVICE_DIR}/audio && find . -name '*.wav' -exec sha256sum {} +`,
    )
      .trim()
      .split('\n')
      .map(line => line.trim().split(/\s+/))
      .map(([sha, file]) => [file.replace(/^\.\//, ''), sha]),
  );
  const mismatched = items.filter(
    item => remote.get(item.file) !== item.sha256,
  );
  if (mismatched.length)
    throw new Error(
      `audio integrity failed on device: ${mismatched
        .map(i => i.file)
        .join(', ')}`,
    );
  return { ...info, audioVerified: items.length, modelVerified: true };
}

async function transcribeDevice(item, slot) {
  const prefix = `${DEVICE_DIR}/out/s${slot}`;
  const { stdout } = await run(
    'adb',
    [
      ...adbArgs,
      'shell',
      `${DEVICE_DIR}/device-run.sh`,
      `ggml-${args.model}.bin`,
      `${DEVICE_DIR}/audio/${item.file}`,
      prefix,
      String(threads),
      ...decoding,
    ],
    { maxBuffer: 16 << 20 },
  );
  const result = /RESULT code=(\d+) start=(\d+) end=(\d+) peakRssKb=(\d+)/.exec(
    stdout,
  );
  const log = adb('shell', 'cat', `${prefix}.log`);
  if (!result || result[1] !== '0')
    return { status: 'failed', error: log.slice(-400) };
  const json = JSON.parse(adb('shell', 'cat', `${prefix}.json`));
  const invalid = validateOutput(json);
  if (invalid) return { status: 'failed', error: `invalid output: ${invalid}` };
  return {
    status: 'ok',
    hypothesis: transcriptOf(json),
    wallMs: Number(BigInt(result[3]) - BigInt(result[2])) / 1e6,
    peakRssKb: Number(result[4]),
    timings: parseTimings(log),
  };
}

async function transcribeHost(item, slot) {
  const prefix = path.join(out, 'host-out', `s${slot}`);
  fs.mkdirSync(path.dirname(prefix), { recursive: true });
  const started = process.hrtime.bigint();
  try {
    const { stderr } = await run(
      path.join(args.whisper, 'build-host/bin/whisper-cli'),
      [
        '-m',
        path.join(args.whisper, 'models', `ggml-${args.model}.bin`),
        '-f',
        path.join(args.dataset, item.file),
        '-t',
        String(threads),
        '-l',
        'en',
        '-oj',
        '-of',
        prefix,
        ...decoding,
      ],
      { maxBuffer: 16 << 20 },
    );
    const json = JSON.parse(fs.readFileSync(`${prefix}.json`, 'utf8'));
    const invalid = validateOutput(json);
    if (invalid)
      return { status: 'failed', error: `invalid output: ${invalid}` };
    return {
      status: 'ok',
      hypothesis: transcriptOf(json),
      wallMs: Number(process.hrtime.bigint() - started) / 1e6,
      timings: parseTimings(stderr),
    };
  } catch (error) {
    return { status: 'failed', error: String(error.message).slice(-400) };
  }
}

// --- Run ----------------------------------------------------------------------------

if (!args.whisper)
  throw new Error(
    '--whisper (or AJ_WHISPER_DIR) must point at the whisper.cpp build directory',
  );
const items = suiteItems(args.suite);
for (const item of items)
  validateWav(fs.readFileSync(path.join(args.dataset, item.file)), item);
const report = {
  startedAt: new Date().toISOString(),
  engine: {
    kind: args.engine,
    name: 'whisper.cpp',
    ...WHISPER,
    model: args.model,
    modelSha256: MODELS[args.model],
    threads,
    beam: Number(args.beam),
  },
  suite: args.suite,
  concurrency,
  dataset: {
    license: manifest.license,
    sources: manifest.sources,
    files: items.length,
  },
};
report.device =
  args.engine === 'device'
    ? await prepareDevice(items)
    : { host: os.hostname(), cores: os.cpus().length, cpu: os.cpus()[0].model };
const transcribe = args.engine === 'device' ? transcribeDevice : transcribeHost;

const samples = [];
const sampler =
  args.engine === 'device'
    ? setInterval(() => {
        try {
          samples.push(deviceSample());
        } catch {
          /* adb busy */
        }
      }, 5_000)
    : undefined;

const results = [];
const soakUntil = Date.now() + Number(args['soak-minutes']) * 60_000;
const started = Date.now();
let pass = 0;
do {
  pass += 1;
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async (_, slot) => {
      while (next < items.length) {
        const item = items[next];
        next += 1;
        const outcome = await transcribe(item, slot);
        const record = {
          pass,
          file: item.file,
          set: item.set,
          condition: item.condition,
          gender: item.gender,
          speakerId: item.speakerId,
          durationSec: item.durationSec,
          ...outcome,
        };
        if (outcome.status === 'ok') {
          record.inferenceMs = outcome.timings.totalMs - outcome.timings.loadMs;
          record.score = scoreUtterance(item.reference, outcome.hypothesis);
        }
        results.push(record);
        fs.appendFileSync(
          path.join(out, 'results.jsonl'),
          `${JSON.stringify({ ...record, reference: item.reference })}\n`,
        );
        if (results.length % 10 === 0) {
          const so = aggregate(results);
          process.stdout.write(
            `  ${results.length} files · WER ${so.wer} · RTF ${so.realTimeFactor}\n`,
          );
        }
      }
    }),
  );
} while (Date.now() < soakUntil);
if (sampler) clearInterval(sampler);

report.wallSec = Math.round((Date.now() - started) / 1000);
report.passes = pass;
report.throughputAudioSecPerSec =
  Math.round(
    (results
      .filter(r => r.status === 'ok')
      .reduce((s, r) => s + r.durationSec, 0) /
      report.wallSec) *
      100,
  ) / 100;
report.overall = aggregate(results);
report.byCondition = groupBy(
  results,
  result => `${result.set}/${result.condition}`,
);
report.byGender = groupBy(
  results.filter(r => ['M', 'F'].includes(r.gender)),
  result => result.gender,
);
report.byPass =
  pass > 1 ? groupBy(results, result => `pass${result.pass}`) : undefined;
report.device.samples = samples;
report.device.summary = samples.length
  ? {
      thermalMax: Math.max(
        ...samples.map(s => s.thermal).filter(Number.isFinite),
        0,
      ),
      batteryTempC: percentiles(
        samples.map(s => s.batteryTempC).filter(Number.isFinite),
      ),
      memAvailableMinKb: Math.min(...samples.map(s => s.memAvailableKb)),
      load1: percentiles(samples.map(s => s.load1)),
    }
  : undefined;
// Deterministic spot checks so a reader can compare raw output with the reference.
report.spotChecks = results
  .filter(
    (result, index) =>
      result.status === 'ok' &&
      index % Math.max(1, Math.floor(results.length / 8)) === 0,
  )
  .slice(0, 8)
  .map(result => ({
    file: result.file,
    wer: Math.round(result.score.wer * 1000) / 1000,
    reference: items.find(item => item.file === result.file).reference,
    hypothesis: result.hypothesis,
  }));
report.worstFiles = results
  .filter(r => r.status === 'ok')
  .sort((a, b) => b.score.wer - a.score.wer)
  .slice(0, 10)
  .map(r => ({
    file: r.file,
    wer: Math.round(r.score.wer * 1000) / 1000,
    words: r.score.referenceWords,
  }));
fs.writeFileSync(
  path.join(out, 'summary.json'),
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify(
    { out, overall: report.overall, wallSec: report.wallSec },
    null,
    2,
  ),
);
