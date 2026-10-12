#!/usr/bin/env node
// AJ-4-P product demonstration journey (roadmap §6.0) on one emulator, through
// the real app, the packaged Hybrid AI SDK (public API), and the Audio Journal
// node companion. Not an edge-case suite.
//
//   clean install → PIN → written entry → voice entry (deterministic speech
//   via the e2e build) → final transcript → playback → pair → organize both
//   entries → Organized → follow a source to its transcript line and audio
//   range → Tasks: mark one done → lock, kill, reopen → everything persists.
//
//   ANDROID_SERIAL=emulator-5554 node e2e/aj4/product-journey.mjs \
//     --apk android/app/build/outputs/apk/e2e/app-e2e.apk [--out <dir>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  openSettingsHome,
  PIN,
  pairWithNode,
  setupPin,
} from '../android/lib/app.mjs';
import * as d from '../android/lib/device.mjs';
import {
  liveDump,
  liveTap,
  liveTextOf,
  liveWaitFor,
  waitForFinalPass,
} from '../aj1/lib/liveScreen.mjs';
import { startCompanion } from '../aj2/lib/companion.mjs';
import { done, organize, writeEntry } from '../aj2/lib/flows.mjs';
import { INPUT, sample, seconds, textsWithin } from '../aj2/lib/voice.mjs';

const { values: args } = parseArgs({
  options: {
    apk: { type: 'string' },
    out: {
      type: 'string',
      default: fs.mkdtempSync(path.join(os.tmpdir(), 'aj4p-journey-')),
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
if (!process.env.ANDROID_SERIAL) throw new Error('ANDROID_SERIAL is required');
if (!args.apk) throw new Error('--apk is required (an e2e build)');
fs.mkdirSync(args.out, { recursive: true });

const WRITTEN =
  'I need to call the bank tomorrow.\n\nRemember to water the plants.';
const TASK = 'Call the bank tomorrow.';
const PRIVATE = ['call the bank', 'water the plants', 'fellow americans'];
const results = [];
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
      error: String(error.message).split('\n')[0],
    });
    process.stdout.write(`FAIL ${String(error.message).split('\n')[0]}\n`);
    throw error;
  }
}

/** Opens a tab from the tab bar (the lowest node with that text). */
async function openTab(name, screenId) {
  const tapTab = () => {
    const bar = d
      .dump()
      .filter(n => n.text === name && n.bounds)
      .sort((a, b) => b.bounds[1] - a.bounds[1])[0];
    if (!bar) throw new Error(`no ${name} tab`);
    const [x0, y0, x1, y1] = bar.bounds;
    d.shell('input', 'tap', String((x0 + x1) >> 1), String((y0 + y1) >> 1));
  };
  for (let i = 0; i < 4 && !d.find(d.dump(), { id: screenId }); i += 1) {
    tapTab();
    await d.sleep(600);
  }
  await d.waitFor({ id: screenId });
  await d.scrollToTop();
}

/** Polls the live hierarchy until `selector` appears; returns elapsed ms. */
async function timeUntil(selector, startedAt, timeoutMs = 30_000) {
  await liveWaitFor(selector, { timeoutMs });
  return Date.now() - startedAt;
}

const pidOf = () => d.shell('pidof', d.PACKAGE).trim().split(/\s+/)[0];
const hwmKb = () =>
  Number(
    /VmHWM:\s+(\d+)/.exec(d.shell('cat', `/proc/${pidOf()}/status`))?.[1] ?? 0,
  );

try {
  await step('J00', 'clean install and create the PIN', async () => {
    if (fs.existsSync(args.fixture)) d.adb('install', '-r', args.fixture);
    d.adb('install', '-r', args.apk);
    d.shell('pm', 'clear', d.PACKAGE);
    d.shell('pm', 'grant', d.PACKAGE, 'android.permission.RECORD_AUDIO');
    d.quietKeyboard();
    d.prepareDeviceLog();
    d.launch();
    await d.waitFor(
      { text: 'Create your private space' },
      { timeoutMs: 90_000 },
    );
    await setupPin();
  });

  await step('J01', 'write a journal entry', async () => {
    await writeEntry({ text: WRITTEN });
  });

  const timings = {};
  await step('J02', 'record a voice entry (deterministic speech)', async () => {
    expect(
      d.shell('ls', '-d', INPUT).trim() === INPUT,
      'no e2e input directory',
    );
    d.adb('push', sample(), `${INPUT}/input.wav`);
    await d.tap({ text: 'Diary' });
    for (
      let i = 0;
      i < 3 && !d.find(d.dump(), { id: 'diary-record' });
      i += 1
    ) {
      await d.tap({ text: 'Diary' });
      await d.sleep(500);
    }
    const tapped = Date.now();
    await d.tap({ id: 'diary-record' });
    timings.captureStartMs = await timeUntil({ id: 'recording-pause' }, tapped);
    await d.sleep(13_000);
    const stopped = Date.now();
    await liveTap({ id: 'recording-finish' });
    await liveWaitFor({ id: 'recording-open-entry' }, { timeoutMs: 30_000 });
    const captured = seconds(liveTextOf({ id: 'recording-timer' }));
    expect(captured >= 12, `captured only ${captured} s`);
    await liveTap({ id: 'recording-open-entry' });
    await liveWaitFor({ id: 'entry-recording' }, { timeoutMs: 30_000 });
    timings.stopped = stopped;
    return {
      capturedSeconds: captured,
      captureStartMs: timings.captureStartMs,
    };
  });

  await step('J03', 'the final on-device transcript', async () => {
    const outcome = await waitForFinalPass();
    expect(outcome !== 'failed', `final pass ${outcome}`);
    await liveWaitFor({ id: 'transcript-kind-final' }, { timeoutMs: 120_000 });
    const stopToFinalMs = Date.now() - timings.stopped;
    const text = liveDump()
      .map(n => n.text)
      .join(' ')
      .toLowerCase();
    expect(
      text.includes('fellow americans'),
      'the transcript lacks the speech',
    );
    return { stopToFinalMs, peakRssKb: hwmKb() };
  });

  await step('J04', 'play the encrypted recording', async () => {
    await d.scrollToTop();
    const tapped = Date.now();
    await liveTap({ id: 'entry-play' });
    const playbackStartMs = await timeUntil({ text: 'Pause' }, tapped, 10_000);
    await d.sleep(2_500);
    const position = seconds(liveTextOf({ id: 'entry-position' }));
    expect(position >= 1, `playback did not advance (${position})`);
    await liveTap({ text: 'Pause' });
    return { playbackStartMs, playedSeconds: position };
  });

  await step('J05', 'pair with the node companion', async () => {
    node = await startCompanion({ name: 'AJ Companion' });
    await pairWithNode(node);
    expect((await node.pairings()).length === 1, 'not paired');
  });

  await step('J06', 'organize the voice entry, with consent', async () => {
    await d.tap({ text: 'Diary' });
    await d.waitFor({ id: 'entry-detail' });
    const run = await organize();
    expect(run.result === 'stored', `outcome ${run.result}`);
    expect(
      /leave this phone|Private AI Node/i.test(run.consentText),
      'no consent text',
    );
    await done();
    return { organizeMs: run.ms };
  });

  await step('J07', 'organize the written entry', async () => {
    await d.tap({ text: 'Diary' });
    for (let i = 0; i < 3 && !d.find(d.dump(), { id: 'diary-write' }); i += 1) {
      await d.tap({ text: 'Diary' });
      await d.sleep(500);
    }
    await d.tap({ textMatches: /call the bank tomorrow/i });
    await d.waitFor({ id: 'entry-detail' });
    const run = await organize();
    expect(run.result === 'stored', `outcome ${run.result}`);
    await done();
    return { organizeMs: run.ms };
  });

  await step(
    'J08',
    'Organized: follow a source to its line and audio range',
    async () => {
      await openTab('Organized', 'organized-screen');
      // Newest first: the voice card is the one whose source names a range.
      // The link's label is drawn by a child node.
      let card;
      for (let i = 0; i < 4 && !card; i += 1) {
        const id = `organized-${i}-source-summary`;
        const found = await d
          .scrollTo({ id }, { maxSwipes: 6 })
          .catch(() => undefined);
        if (found && /\d+:\d\d–\d+:\d\d/.test(textsWithin(id).join(' '))) {
          card = id;
        }
      }
      expect(card, 'no voice source link on the Organized cards');
      await d.tap({ id: card });
      await liveWaitFor({ id: 'cited-source' }, { timeoutMs: 20_000 });
      const range = liveTextOf({ id: 'cited-range' });
      expect(
        /\d+:\d\d–\d+:\d\d/.test(range ?? ''),
        `no audio range (${range})`,
      );
      await d.findScrolling({ id: 'transcript-cited' });
      d.back();
      await d.waitFor({ id: 'organized-screen' });
      return { citedRange: range };
    },
  );

  await step('J09', 'Tasks: mark one task done', async () => {
    await openTab('Tasks', 'tasks-screen');
    let row;
    for (const group of ['today', 'upcoming', 'overdue', 'undated']) {
      for (let i = 0; i < 6 && !row; i += 1) {
        const id = `task-${group}-${i}`;
        const text = await d.readText({ id: `${id}-text` }, { maxSwipes: 4 });
        if (text === undefined) break;
        if (text === TASK) row = id;
      }
    }
    expect(row, `"${TASK}" is not listed`);
    await d.tap({ id: `${row}-done` });
    await d.findScrolling({ id: 'task-done-0-text', text: TASK });
  });

  await step('J10', 'lock, kill, and reopen: everything persists', async () => {
    await openSettingsHome();
    await d.tap({ id: 'lock-now' });
    await d.waitFor({ id: 'unlock-pin' });
    d.forceStop();
    d.launch();
    await d.waitFor({ id: 'unlock-pin' }, { timeoutMs: 60_000 });
    await d.typeInto({ id: 'unlock-pin' }, PIN);
    await d.hideKeyboard();
    await d.tap({ text: 'Unlock' });
    await d.waitFor({ text: 'Settings' });
    await openTab('Diary', 'diary-write');
    await d.findScrolling({ textMatches: /call the bank tomorrow/i });
    await openTab('Organized', 'organized-screen');
    await d.findScrolling({ id: 'organized-1' });
    await openTab('Tasks', 'tasks-screen');
    await d.findScrolling({ id: 'task-done-0-text', text: TASK });
  });

  await step(
    'J11',
    'privacy: no journal text in the device or companion log',
    async () => {
      const logFile = path.join(args.out, 'device.log');
      d.saveDeviceLog(logFile);
      fs.writeFileSync(path.join(args.out, 'companion.log'), node.log.join(''));
      const logs = [fs.readFileSync(logFile, 'utf8'), node.log.join('')]
        .join('\n')
        .toLowerCase();
      for (const phrase of PRIVATE) {
        expect(!logs.includes(phrase), `a log contains "${phrase}"`);
      }
    },
  );
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
  const failed = results.filter(r => r.result === 'fail').length;
  process.stdout.write(
    `\n${results.length - failed}/${results.length} passed; report in ${
      args.out
    }\n`,
  );
  process.exitCode = failed || results.length < 12 ? 1 : 0;
}
