#!/usr/bin/env node
// AJ-RI-2 transcription journey (GRI-2 AJ rows) through the real app UI and
// production paths: the e2e build's capture reads a pushed public LibriSpeech
// clip (the pinned RI-2 corpus) as microphone input at real-time pace; it is
// sealed into AJR1; the final pass runs through the packaged Hybrid AI SDK.
//
//   J01/J02  30 s and 60 s recordings transcribe after Finish
//   J03      ~180 s recording; HOME (which locks at once) during the pass;
//            after unlock the pass is queued again and completes
//   J04      process death (kill -9) during the pass; after relaunch and
//            unlock the recording is intact and the pass completes
//   J05      user cancel during a 60 s pass, then a user retry completes
//   J07      a recording past 3:00 shows the typed unsupported state, is never
//            sent, and stays stored
//   J06      device-log privacy scan: no transcript words, no paths or keys (last)
//
//   ANDROID_SERIAL=emulator-5554 node e2e/aj-ri2/transcription-journey.mjs \
//     --apk android/app/build/outputs/apk/e2e/app-e2e.apk \
//     --corpus ../ri2-evidence/corpus --out <dir>
//
// Transcripts of the public clips go only to <out>/transcripts.json for WER
// scoring; console output and the report carry codes and times only.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { setupPin, unlockIfNeeded } from '../android/lib/app.mjs';
import * as d from '../android/lib/device.mjs';
import {
  liveDump,
  liveTap,
  liveTextOf,
  liveWaitFor,
  liveWaitForAny,
  waitForFinalPass,
} from '../aj1/lib/liveScreen.mjs';
import { INPUT, seconds } from '../aj2/lib/voice.mjs';

const { values: args } = parseArgs({
  options: {
    apk: { type: 'string' },
    corpus: { type: 'string' },
    out: { type: 'string' },
  },
});
if (!process.env.ANDROID_SERIAL) throw new Error('ANDROID_SERIAL must be set');
if (!args.apk || !args.corpus || !args.out) {
  throw new Error('--apk, --corpus, and --out are required');
}
fs.mkdirSync(args.out, { recursive: true });

const manifest = JSON.parse(
  fs.readFileSync(path.join(args.corpus, 'manifest.json'), 'utf8'),
);
const clip = id => {
  const entry = manifest.clips.find(c => c.id === id);
  const file = path.join(args.corpus, 'audio', `${id}.wav`);
  const sha = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (sha !== entry.wavSha256) throw new Error(`clip hash mismatch: ${id}`);
  return { ...entry, file };
};

const results = [];
const transcripts = [];
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

async function step(id, title, work) {
  const started = Date.now();
  process.stdout.write(`${id} ${title} ... `);
  try {
    const detail = (await work()) ?? {};
    results.push({
      id,
      title,
      result: 'pass',
      ms: Date.now() - started,
      ...detail,
    });
    process.stdout.write('pass\n');
  } catch (error) {
    results.push({
      id,
      title,
      result: 'fail',
      error: String(error.message).split('\n').slice(0, 2).join(' / '),
    });
    process.stdout.write(`FAIL ${String(error.message).split('\n')[0]}\n`);
    throw error;
  }
}

/** The app's PID, or '' when no process runs (`pidof` then exits non-zero). */
const pid = () => {
  try {
    return d.shell('pidof', d.PACKAGE).trim();
  } catch {
    return '';
  }
};
function peakKiB() {
  const status = d.shell('cat', `/proc/${pid()}/status`);
  return Number(/VmHWM:\s+(\d+)/.exec(status)?.[1] ?? NaN);
}

async function toDiary() {
  await d.tap({ text: 'Diary' });
  for (let i = 0; i < 3 && !d.find(d.dump(), { id: 'diary-record' }); i += 1) {
    await d.tap({ text: 'Diary' });
    await d.sleep(500);
  }
}

/** Records `c` through the capture path; Finish at `stopAtSeconds` on the timer. */
async function record(c, stopAtSeconds) {
  expect(d.shell('ls', '-d', INPUT).trim() === INPUT, 'no e2e input directory');
  d.adb('push', c.file, `${INPUT}/input.wav`);
  await toDiary();
  await d.tap({ id: 'diary-record' });
  await liveWaitFor({ id: 'recording-pause' }, { timeoutMs: 30_000 });
  for (;;) {
    const at = seconds(liveTextOf({ id: 'recording-timer' }));
    if (at >= stopAtSeconds) break;
    await d.sleep(at < stopAtSeconds - 5 ? 2_000 : 200);
  }
  await liveTap({ id: 'recording-finish' });
  const finishedAt = Date.now();
  await liveWaitFor({ id: 'recording-open-entry' }, { timeoutMs: 30_000 });
  const captured = seconds(liveTextOf({ id: 'recording-timer' }));
  expect(
    !d.shell('ls', INPUT).includes('input.wav'),
    'capture did not read the input',
  );
  await liveTap({ id: 'recording-open-entry' });
  await liveWaitFor({ id: 'entry-recording' }, { timeoutMs: 30_000 });
  return { captured, finishedAt };
}

/** The open entry's transcript lines (public clip speech). */
function transcriptText() {
  return liveDump()
    .filter(n => /^transcript-text-/.test(n.id))
    .map(n => n.text)
    .join(' ');
}

async function finalPass(id, since, timeoutMs = 240_000) {
  const outcome = await waitForFinalPass({ timeoutMs });
  expect(outcome === 'final', `final pass ${outcome}`);
  const latencyMs = Date.now() - since;
  transcripts.push({ id, text: transcriptText() });
  return { latencyMs, peakRssKiB: peakKiB() };
}

async function openNewestEntry() {
  await toDiary();
  const { node } = await liveWaitForAny([{ id: 'diary-screen' }], {
    timeoutMs: 30_000,
  });
  void node;
  const rows = liveDump().filter(n => /^entry-row-/.test(n.id) && n.bounds);
  expect(rows.length > 0, 'no diary rows');
  rows.sort((a, b) => a.bounds[1] - b.bounds[1]);
  await liveTap({ id: rows[0].id });
  await liveWaitFor({ id: 'entry-recording' }, { timeoutMs: 30_000 });
}

async function relaunchAndUnlock() {
  d.launch();
  await d.waitForAny([{ id: 'unlock-pin' }, { text: 'Settings' }], {
    timeoutMs: 60_000,
  });
  const locked = !!d.find(d.dump(), { id: 'unlock-pin' });
  await unlockIfNeeded();
  return locked;
}

let report;
try {
  await step(
    'J00',
    'install the e2e build and protect the journal',
    async () => {
      d.adb('install', '-r', args.apk);
      d.shell('pm', 'clear', d.PACKAGE);
      d.shell('pm', 'grant', d.PACKAGE, 'android.permission.RECORD_AUDIO');
      report = d.prepareDeviceLog();
      d.launch();
      await d.waitFor(
        { text: 'Create your private space' },
        { timeoutMs: 90_000 },
      );
      await setupPin();
      return { api: d.apiLevel() };
    },
  );

  for (const [sid, id] of [
    ['J01', 'ls-61-30s'],
    ['J02', 'ls-237-60s'],
  ]) {
    await step(sid, `${id}: record, Finish, SDK final pass`, async () => {
      const c = clip(id);
      const { captured, finishedAt } = await record(
        c,
        Math.ceil(c.durationMs / 1000) + 1,
      );
      return { clip: id, captured, ...(await finalPass(id, finishedAt)) };
    });
  }

  await step(
    'J03',
    'ls-61-180s: lock during the pass, unlock, pass completes',
    async () => {
      const c = clip('ls-61-180s');
      // Finish before 3:00 so the recording stays within the profile limit.
      // Finish lands ~3 s after the timer target.
      const { captured, finishedAt } = await record(c, 175);
      expect(captured <= 180, `captured ${captured} s`);
      await liveWaitFor({ id: 'transcript-running' }, { timeoutMs: 30_000 });
      await d.sleep(5_000);
      d.home(); // backgrounding locks at once (ADR-017)
      const lockedAt = Date.now();
      await d.sleep(3_000);
      const locked = await relaunchAndUnlock();
      expect(locked, 'the app did not lock on background');
      await openNewestEntry();
      expect(
        !d.find(liveDump(), { id: 'transcript-kind-final' }),
        'a transcript survived the lock',
      );
      const pass = await finalPass('ls-61-180s', lockedAt);
      return { clip: c.id, captured, ...pass };
    },
  );

  await step(
    'J04',
    'ls-121-60s: process death during the pass, recovery after unlock',
    async () => {
      const c = clip('ls-121-60s');
      const { captured } = await record(c, Math.ceil(c.durationMs / 1000) + 1);
      await liveWaitFor({ id: 'transcript-running' }, { timeoutMs: 30_000 });
      await d.sleep(3_000);
      const before = pid();
      // SIGKILL as root (userdebug emulator): the shell user may not signal the app.
      d.shell('su', '0', 'kill', '-9', before);
      const killedAt = Date.now();
      await d.sleep(2_000);
      expect(pid() !== before, 'the process survived kill -9');
      const locked = await relaunchAndUnlock();
      expect(locked, 'a restarted process must start locked');
      await openNewestEntry();
      const pass = await finalPass('ls-121-60s', killedAt);
      return { clip: c.id, captured, ...pass };
    },
  );

  await step(
    'J05',
    'ls-260-60s: user cancel during the pass, then retry',
    async () => {
      const c = clip('ls-260-60s');
      const { captured } = await record(c, Math.ceil(c.durationMs / 1000) + 1);
      // Cancel as soon as the pass shows (a 60 s pass takes ~11 s here).
      await liveTap({ id: 'transcript-cancel' }, { timeoutMs: 30_000 });
      await liveWaitFor({ id: 'transcript-start' }, { timeoutMs: 15_000 });
      expect(
        !d.find(liveDump(), { id: 'transcript-kind-final' }),
        'cancel stored a transcript',
      );
      await liveTap({ id: 'transcript-start' });
      const retriedAt = Date.now();
      return {
        clip: c.id,
        captured,
        ...(await finalPass('ls-260-60s', retriedAt)),
      };
    },
  );

  await step(
    'J07',
    'ls-121-180s past 3:00: typed unsupported, never sent, recording kept',
    async () => {
      const c = clip('ls-121-180s');
      const { captured } = await record(c, 183);
      expect(captured > 180, `captured only ${captured} s`);
      await liveWaitFor(
        { id: 'transcript-unsupported' },
        { timeoutMs: 15_000 },
      );
      const nodes = liveDump();
      expect(
        !d.find(nodes, { id: 'transcript-running' }),
        'an over-limit recording was sent',
      );
      expect(
        !d.find(nodes, { id: 'transcript-start' }),
        'a transcribe action was offered',
      );
      // The recording stays stored and openable (the dump above can miss it).
      await liveWaitFor({ id: 'entry-recording' }, { timeoutMs: 10_000 });
      return { clip: c.id, captured };
    },
  );

  await step(
    'J06',
    'device log holds no transcript words, paths, or keys',
    async () => {
      const log = path.join(args.out, 'logcat.txt');
      d.saveDeviceLog(log);
      const text = fs.readFileSync(log, 'utf8').toLowerCase();
      const findings = [];
      for (const t of transcripts) {
        const words = t.text
          .toLowerCase()
          .replace(/[^a-z' ]+/g, ' ')
          .split(/\s+/)
          .filter(Boolean);
        for (let i = 0; i + 4 <= words.length; i += 1) {
          const phrase = words.slice(i, i + 4).join(' ');
          if (text.includes(phrase)) findings.push(`${t.id}:transcript-phrase`);
        }
      }
      for (const marker of [
        '/no_backup/recordings',
        '.ajr',
        'aj-rec-v1',
        'input.wav',
        'segmentsjson',
      ]) {
        if (text.includes(marker)) findings.push(`marker:${marker}`);
      }
      fs.writeFileSync(
        path.join(args.out, 'privacy-findings.json'),
        JSON.stringify(findings, null, 2),
      );
      expect(findings.length === 0, `${findings.length} privacy findings`);
      return {
        findings: 0,
        logBytes: text.length,
        prunedBuffers: d.nearlyFullLogBuffers(),
      };
    },
  );
} finally {
  fs.writeFileSync(
    path.join(args.out, 'transcripts.json'),
    JSON.stringify({ clips: transcripts }, null, 2),
  );
  fs.writeFileSync(
    path.join(args.out, 'journey-report.json'),
    JSON.stringify(
      {
        evidenceClass: 'REAL_MODEL_PUBLIC_SDK',
        device: report,
        steps: results,
      },
      null,
      2,
    ),
  );
}
