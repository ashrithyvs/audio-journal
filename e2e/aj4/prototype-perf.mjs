#!/usr/bin/env node
// AJ-4-P prototype performance on one emulator: emulator development
// measurements, not physical-device budgets.
//
//   --part launch-audio (release APK): cold and warm launch (`am start -W`);
//     capture start and playback start, measured on the device clock from a
//     logcat marker written just before the tap to the audio server's first
//     line for the new stream (AudioFlinger), so UI polling does not inflate
//     them. The emulator microphone records silence.
//   --part voice (e2e APK): real-time captures of 30 s, 1, 3, 5, and 10 min of
//     read speech (prefixes of the speech dataset's 10-minute long form, fed
//     as microphone input), then stop → final transcript, its real-time
//     factor, and the app's peak RSS while the final pass runs.
//
//   ANDROID_SERIAL=emulator-5554 node e2e/aj4/prototype-perf.mjs --part voice \
//     --apk <app-e2e.apk> --out <dir> [--durations 30,60,180,300,600] [--reps 3]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { setupPin, unlockIfNeeded } from '../android/lib/app.mjs';
import * as d from '../android/lib/device.mjs';
import {
  liveTap,
  liveTextOf,
  liveWaitFor,
  waitForFinalPass,
} from '../aj1/lib/liveScreen.mjs';
import { INPUT, seconds } from '../aj2/lib/voice.mjs';

const { values: args } = parseArgs({
  options: {
    part: { type: 'string' },
    apk: { type: 'string' },
    out: {
      type: 'string',
      default: fs.mkdtempSync(path.join(os.tmpdir(), 'aj4p-perf-')),
    },
    durations: { type: 'string', default: '30,60,180,300,600' },
    reps: { type: 'string', default: '3' },
    wav: {
      type: 'string',
      default: path.resolve(
        import.meta.dirname,
        '../../../audio-journal/e2e/speech/.cache/dataset/long/long10m.wav',
      ),
    },
  },
});
if (!process.env.ANDROID_SERIAL) throw new Error('ANDROID_SERIAL is required');
if (!args.apk || !['launch-audio', 'voice'].includes(args.part)) {
  throw new Error('--apk and --part launch-audio|voice are required');
}
fs.mkdirSync(args.out, { recursive: true });
const report = { part: args.part, apk: args.apk, api: d.apiLevel(), runs: [] };

const pidOf = () => d.shell('pidof', d.PACKAGE).trim().split(/\s+/)[0];
const status = key => {
  const m = new RegExp(`${key}:\\s+(\\d+)`).exec(
    d.shell('cat', `/proc/${pidOf()}/status`),
  );
  return m ? Number(m[1]) : null;
};

function stats(values) {
  const v = values.filter(x => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  const q = p => v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)];
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  return {
    n: v.length,
    p50: q(50),
    p95: q(95),
    min: v[0],
    max: v.at(-1),
    cv: mean ? sd / mean : 0,
  };
}

/** ms from the AJ4P marker to the audio server's first line after it. */
function audioLatencyMs(marker) {
  const lines = d.adb('logcat', '-d', '-v', 'epoch').split('\n');
  const at = lines.findIndex(l => l.includes(`AJ4P`) && l.includes(marker));
  if (at < 0) return null;
  const t0 = Number(lines[at].trim().split(/\s+/)[0]);
  const next = lines
    .slice(at + 1)
    .find(
      l =>
        /\s(AudioFlinger|AudioRecord|AudioTrack|AudioPolicy\w*)\s*:/.test(l) &&
        !/throttle/.test(l),
    );
  return next
    ? Math.round((Number(next.trim().split(/\s+/)[0]) - t0) * 1000)
    : null;
}

async function tapWithMarker(selector, marker) {
  const node = await d.scrollTo(selector);
  const [x0, y0, x1, y1] = node.bounds;
  d.adb('logcat', '-c');
  d.shell('log', '-t', 'AJ4P', marker);
  d.shell('input', 'tap', String((x0 + x1) >> 1), String((y0 + y1) >> 1));
}

async function toDiary() {
  await d.tap({ text: 'Diary' });
  for (let i = 0; i < 3 && !d.find(d.dump(), { id: 'diary-record' }); i += 1) {
    await d.tap({ text: 'Diary' });
    await d.sleep(500);
  }
}

/** A prefix of the dataset's long form, as a 16 kHz mono 16-bit WAV. */
function prefixWav(secondsWanted) {
  const src = fs.readFileSync(args.wav);
  const dataAt = src.indexOf(Buffer.from('data')) + 8;
  const bytes = Math.min(src.length - dataAt, secondsWanted * 16000 * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + bytes, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(bytes, 40);
  const file = path.join(args.out, `speech-${secondsWanted}s.wav`);
  fs.writeFileSync(
    file,
    Buffer.concat([header, src.subarray(dataAt, dataAt + bytes)]),
  );
  return file;
}

async function install() {
  d.adb('install', '-r', args.apk);
  d.shell('pm', 'clear', d.PACKAGE);
  d.shell('pm', 'grant', d.PACKAGE, 'android.permission.RECORD_AUDIO');
  d.quietKeyboard();
  d.launch();
  await d.waitFor({ text: 'Create your private space' }, { timeoutMs: 90_000 });
  await setupPin();
}

try {
  await install();
  const reps = Number(args.reps);
  if (args.part === 'launch-audio') {
    const launch = { cold: [], warm: [] };
    for (let i = 0; i < (process.env.AJ4P_SKIP_LAUNCH ? 0 : 5); i += 1) {
      d.forceStop();
      await d.sleep(1_500);
      const out = d.shell(
        'am',
        'start',
        '-W',
        '-n',
        `${d.PACKAGE}/.MainActivity`,
      );
      launch.cold.push(Number(/TotalTime: (\d+)/.exec(out)?.[1]));
      await d.sleep(3_000);
      d.home();
      await d.sleep(1_500);
      const warm = d.shell(
        'am',
        'start',
        '-W',
        '-n',
        `${d.PACKAGE}/.MainActivity`,
      );
      launch.warm.push(Number(/TotalTime: (\d+)/.exec(warm)?.[1]));
      await d.sleep(2_000);
    }
    report.launch = {
      cold: launch.cold,
      warm: launch.warm,
      coldStats: stats(launch.cold),
      warmStats: stats(launch.warm),
    };
    const capture = [];
    const playback = [];
    for (let i = 0; i < 5; i += 1) {
      await unlockIfNeeded();
      await toDiary();
      await tapWithMarker({ id: 'diary-record' }, `record-${i}`);
      await liveWaitFor({ id: 'recording-pause' }, { timeoutMs: 30_000 });
      capture.push(audioLatencyMs(`record-${i}`));
      await d.sleep(4_000);
      await liveTap({ id: 'recording-finish' });
      await liveWaitFor({ id: 'recording-open-entry' }, { timeoutMs: 30_000 });
      await liveTap({ id: 'recording-open-entry' });
      await liveWaitFor({ id: 'entry-play' }, { timeoutMs: 30_000 });
      await tapWithMarker({ id: 'entry-play' }, `play-${i}`);
      await d.sleep(2_500);
      playback.push(audioLatencyMs(`play-${i}`));
      // A short recording may finish playing before this tap: tolerate it.
      await d
        .tap({ text: 'Pause' }, { timeoutMs: 1_000 })
        .catch(() => undefined);
    }
    report.captureStartMs = { values: capture, stats: stats(capture) };
    report.playbackStartMs = { values: playback, stats: stats(playback) };
  } else {
    for (const D of args.durations.split(',').map(Number)) {
      const n = D <= 60 ? reps : 1;
      const wav = prefixWav(D);
      for (let r = 0; r < n; r += 1) {
        await unlockIfNeeded();
        d.adb('push', wav, `${INPUT}/input.wav`);
        await toDiary();
        await d.tap({ id: 'diary-record' });
        await liveWaitFor({ id: 'recording-pause' }, { timeoutMs: 30_000 });
        await d.sleep(D * 1000 + 2_000);
        const stopped = Date.now();
        await liveTap({ id: 'recording-finish' });
        await liveWaitFor(
          { id: 'recording-open-entry' },
          { timeoutMs: 60_000 },
        );
        const captured = seconds(liveTextOf({ id: 'recording-timer' }));
        await liveTap({ id: 'recording-open-entry' });
        await liveWaitFor({ id: 'entry-recording' }, { timeoutMs: 60_000 });
        let peakRssKb = status('VmRSS');
        const sampler = setInterval(() => {
          try {
            peakRssKb = Math.max(peakRssKb, status('VmRSS') ?? 0);
          } catch {
            // between samples
          }
        }, 2_000);
        const outcome = await waitForFinalPass({
          timeoutMs: Math.max(300_000, D * 3000),
        });
        await liveWaitFor(
          { id: 'transcript-kind-final' },
          { timeoutMs: 120_000 },
        ).catch(() => undefined);
        const stopToFinalMs = Date.now() - stopped;
        clearInterval(sampler);
        const run = {
          speechSeconds: D,
          rep: r + 1,
          capturedSeconds: captured,
          outcome,
          stopToFinalMs,
          rtf: Number((stopToFinalMs / 1000 / captured).toFixed(3)),
          peakRssKb,
          hwmKb: status('VmHWM'),
        };
        report.runs.push(run);
        process.stdout.write(`${JSON.stringify(run)}\n`);
      }
    }
  }
} catch (error) {
  report.error = String(error.message).split('\n')[0];
  process.stdout.write(`FAIL ${report.error}\n`);
} finally {
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(args.out, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  process.stdout.write(`report in ${args.out}\n`);
  process.exitCode = report.error ? 1 : 0;
}
