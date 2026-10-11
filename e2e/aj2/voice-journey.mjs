#!/usr/bin/env node
// AJ-2 real voice-entry organization journey (owner requirement,
// 2026-10-11), through the real app UI and production paths:
// - capture: the app's own capture path. The `e2e` build feeds the AJ-1
//   speech sample (whisper.cpp's public-domain `jfk.wav`, the pinned SHA-256
//   of `e2e/aj1/speech.mjs`) as microphone input; it is sealed into AJR1;
// - the on-device final pass (whisper.cpp) makes the finalized transcript;
// - journal.organize@1 runs only through the public Hybrid AI SDK, against
//   the node companion;
// - the app validates the result's transcript and audio-range provenance
//   and persists the derivation;
// - an organized item opens the cited transcript line, and exactly the
//   cited audio range plays.
//
//   ANDROID_SERIAL=emulator-5554 node e2e/aj2/voice-journey.mjs \
//     --apk android/app/build/outputs/apk/e2e/app-e2e.apk [--out <dir>]
//
// No audio is committed: the sample comes from the speech engine's pinned
// whisper.cpp source tree. The synthetic duration ladder for repeatable
// performance stays in organize-perf.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { pairWithNode, setupPin } from '../android/lib/app.mjs';
import * as d from '../android/lib/device.mjs';
import {
  liveDump,
  liveTap,
  liveTextOf,
  liveWaitFor,
  waitForFinalPass,
} from '../aj1/lib/liveScreen.mjs';
import { startCompanion } from './lib/companion.mjs';
import { done, organize, reachPanel } from './lib/flows.mjs';
import { recordSample, sample, seconds, textsWithin } from './lib/voice.mjs';

const { values: args } = parseArgs({
  options: {
    apk: { type: 'string' },
    out: {
      type: 'string',
      default: fs.mkdtempSync(path.join(os.tmpdir(), 'aj2-voice-')),
    },
    fixture: {
      type: 'string',
      default: path.resolve(
        import.meta.dirname,
        '../../../audio-journal/e2e/android/nsd-fixture/build/outputs/apk/debug/aj-nsd-fixture-debug.apk',
      ),
    },
  },
});
if (!process.env.ANDROID_SERIAL) {
  throw new Error('ANDROID_SERIAL must name the device under test');
}
if (!args.apk) throw new Error('--apk is required (an e2e build)');
fs.mkdirSync(args.out, { recursive: true });

const ROOT = path.resolve(import.meta.dirname, '..', '..');
// Words of the sample that must reach the transcript, and never a log.
const SPOKEN = ['fellow americans', 'your country'];

const results = [];
const evidence = [];
let node;

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

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
      error: String(error.message).split('\n').slice(0, 3).join(' / '),
    });
    process.stdout.write(`FAIL ${error.message.split('\n')[0]}\n`);
    throw error;
  }
}

let transcript = '';
let cited;

try {
  await step(
    'V00',
    'install the e2e build, PIN, companion, pairing',
    async () => {
      if (fs.existsSync(args.fixture)) d.adb('install', '-r', args.fixture);
      d.adb('install', '-r', args.apk);
      d.shell('pm', 'clear', d.PACKAGE);
      d.shell('pm', 'grant', d.PACKAGE, 'android.permission.RECORD_AUDIO');
      d.prepareDeviceLog();
      d.launch();
      await d.waitFor(
        { text: 'Create your private space' },
        { timeoutMs: 90_000 },
      );
      await setupPin();
      node = await startCompanion({ name: 'AJ Companion' });
      await pairWithNode(node);
      return { sample: path.relative(ROOT, sample()) };
    },
  );

  await step(
    'V01',
    'record the sample through the app capture path',
    async () => {
      const captured = await recordSample();
      return { capturedSeconds: captured };
    },
  );

  await step(
    'V02',
    'the on-device final pass makes the finalized transcript',
    async () => {
      const outcome = await waitForFinalPass();
      expect(outcome !== 'failed', `final pass ${outcome}`);
      await liveWaitFor({ id: 'transcript-kind-final' }, { timeoutMs: 60_000 });
      transcript = liveDump()
        .map(n => n.text)
        .join(' ')
        .toLowerCase();
      for (const words of SPOKEN) {
        expect(transcript.includes(words), `transcript lacks "${words}"`);
      }
      evidence.push({ step: 'V02', ui: d.snapshot() });
    },
  );

  await step(
    'V03',
    'organize through the public SDK; validate and persist',
    async () => {
      const run = await organize();
      expect(run.result === 'stored', `outcome ${run.result}`);
      expect(
        /Audio never leaves this phone/.test(run.consentText),
        'consent does not say text only',
      );
      evidence.push({ step: 'V03', ui: run.ui });
      await done();
      await reachPanel();
      await d.findScrolling({ id: 'organize-summary-source' });
      // The link's label is drawn by a child Text node.
      const label = textsWithin('organize-summary-source').join(' ');
      const range = /Source · (\d+:\d\d)–(\d+:\d\d)/.exec(label ?? '');
      expect(range, `the summary cites no audio range: ${label}`);
      cited = { start: seconds(range[1]), end: seconds(range[2]), label };
      expect(
        cited.start < cited.end && cited.end <= 13,
        `cited range ${label} is outside the recording`,
      );
      return { citedLabel: label };
    },
  );

  await step(
    'V04',
    'open the cited source from the organized item',
    async () => {
      await d.tap({ id: 'organize-summary-source' });
      await liveWaitFor({ id: 'cited-source' }, { timeoutMs: 20_000 });
      const range = liveTextOf({ id: 'cited-range' });
      expect(
        range && cited.label.endsWith(range),
        `cited range ${range} differs from ${cited.label}`,
      );
      const excerpt = (liveTextOf({ id: 'cited-text' }) ?? '').toLowerCase();
      expect(excerpt.length > 0, 'no cited excerpt');
      await d.findScrolling({ id: 'transcript-cited' });
      const texts = textsWithin('transcript-cited');
      const lineText = texts.find(t => !/^\d+:\d\d$/.test(t)) ?? '';
      expect(
        lineText.toLowerCase().includes(excerpt),
        'the excerpt is not in the cited transcript line',
      );
      // The line's own timestamp (its segment start) is the nearest
      // time-only text before the line's text: the cited range begins there.
      const nodes = liveDump();
      const box = nodes.find(n => n.id === 'transcript-cited')?.bounds;
      // The same words also appear in the excerpt and the summary: take the
      // copy inside the highlighted line.
      const at = nodes.findIndex(
        n =>
          n.text === lineText &&
          box &&
          n.bounds &&
          n.bounds[1] >= box[1] &&
          n.bounds[3] <= box[3],
      );
      const stamp = nodes
        .slice(0, at)
        .reverse()
        .find(n => /^\d+:\d\d$/.test(n.text))?.text;
      expect(
        seconds(stamp) === cited.start,
        `cited line starts at ${stamp}, the range at ${cited.start} s`,
      );
      const line = [stamp, lineText];
      return { citedLine: line };
    },
  );

  await step('V05', 'play exactly the cited audio range', async () => {
    await d.scrollToTop();
    await liveTap({ id: 'cited-play' });
    const positions = [];
    const deadline = Date.now() + (cited.end - cited.start + 20) * 1000;
    let state = '';
    while (Date.now() < deadline) {
      state = liveTextOf({ id: 'cited-state' }) ?? '';
      if (state === 'Played') break;
      if (/\d+:\d\d/.test(state)) positions.push(seconds(state));
      await d.sleep(400);
    }
    expect(state === 'Played', `playback ended as "${state}"`);
    expect(
      positions.every(p => p >= cited.start && p <= cited.end),
      `positions ${positions} outside ${cited.start}–${cited.end} s`,
    );
    return { positions };
  });

  await step('V06', 'privacy: no transcript words in either log', async () => {
    const logFile = path.join(args.out, 'device.log');
    d.saveDeviceLog(logFile);
    const deviceLog = fs.readFileSync(logFile, 'utf8').toLowerCase();
    const companionLog = node.log.join('').toLowerCase();
    fs.writeFileSync(path.join(args.out, 'companion.log'), node.log.join(''));
    for (const words of SPOKEN) {
      expect(!deviceLog.includes(words), `device log contains "${words}"`);
      expect(
        !companionLog.includes(words),
        `companion log contains "${words}"`,
      );
    }
  });
} catch {
  // Reported by the failing step.
} finally {
  await node?.stop?.();
  fs.writeFileSync(
    path.join(args.out, 'report.json'),
    `${JSON.stringify(
      {
        apk: args.apk,
        api: d.apiLevel(),
        serial: process.env.ANDROID_SERIAL,
        finishedAt: new Date().toISOString(),
        results,
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(args.out, 'evidence.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  const failed = results.filter(r => r.result === 'fail').length;
  process.stdout.write(
    `\n${results.length - failed}/${results.length} passed; report in ${
      args.out
    }\n`,
  );
  process.exitCode = failed || results.length < 7 ? 1 : 0;
}
