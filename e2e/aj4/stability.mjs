#!/usr/bin/env node
// AJ-4-P short stability check (roadmap §6.0): repeated ordinary use for a
// fixed time on one emulator. Each cycle writes an entry, records the speech
// sample (e2e build) and waits for its final transcript, organizes it through
// the node companion, visits Organized and Tasks, and every other cycle locks
// and unlocks. It records each operation's outcome, crashes and ANRs from the
// device log, and the app's memory at start and end. Not a soak or a leak
// certification.
//
//   ANDROID_SERIAL=emulator-5554 node e2e/aj4/stability.mjs \
//     --apk <app-e2e.apk> --minutes 18 --out <dir>
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
  liveTap,
  liveWaitFor,
  waitForFinalPass,
} from '../aj1/lib/liveScreen.mjs';
import { startCompanion } from '../aj2/lib/companion.mjs';
import { done, organize, writeEntry } from '../aj2/lib/flows.mjs';
import { INPUT, sample } from '../aj2/lib/voice.mjs';

const { values: args } = parseArgs({
  options: {
    apk: { type: 'string' },
    minutes: { type: 'string', default: '18' },
    out: {
      type: 'string',
      default: fs.mkdtempSync(path.join(os.tmpdir(), 'aj4p-stability-')),
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

const pidOf = () => d.shell('pidof', d.PACKAGE).trim().split(/\s+/)[0];
function memory() {
  const pid = pidOf();
  const proc = d.shell('cat', `/proc/${pid}/status`);
  const meminfo = d.shell('dumpsys', 'meminfo', d.PACKAGE);
  const kb = re => Number(re.exec(proc)?.[1] ?? 0);
  return {
    pid,
    rssKb: kb(/VmRSS:\s+(\d+)/),
    hwmKb: kb(/VmHWM:\s+(\d+)/),
    pssKb: Number(
      /TOTAL PSS:\s+(\d+)/.exec(meminfo)?.[1] ??
        /TOTAL\s+(\d+)/.exec(meminfo)?.[1] ??
        0,
    ),
  };
}

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
}

const ops = [];
async function op(cycle, name, work) {
  const started = Date.now();
  try {
    const detail = (await work()) ?? {};
    ops.push({ cycle, name, ok: true, ms: Date.now() - started, ...detail });
  } catch (error) {
    ops.push({
      cycle,
      name,
      ok: false,
      ms: Date.now() - started,
      error: String(error.message).split('\n')[0],
    });
    // Recover to a known screen for the next cycle.
    d.ensureForeground();
  }
}

const report = {
  apk: args.apk,
  api: d.apiLevel(),
  minutes: Number(args.minutes),
};
let node;
try {
  if (fs.existsSync(args.fixture)) d.adb('install', '-r', args.fixture);
  d.adb('install', '-r', args.apk);
  d.shell('pm', 'clear', d.PACKAGE);
  d.shell('pm', 'grant', d.PACKAGE, 'android.permission.RECORD_AUDIO');
  d.quietKeyboard();
  d.prepareDeviceLog();
  d.launch();
  await d.waitFor({ text: 'Create your private space' }, { timeoutMs: 90_000 });
  await setupPin();
  node = await startCompanion({ name: 'AJ Companion' });
  await pairWithNode(node);
  report.start = memory();
  report.startedAt = new Date().toISOString();
  const deadline = Date.now() + Number(args.minutes) * 60_000;
  let cycle = 0;
  while (Date.now() < deadline) {
    cycle += 1;
    await op(cycle, 'write', () =>
      writeEntry({
        text: `Stability note ${cycle}: I need to file report ${cycle}.`,
      }),
    );
    await op(cycle, 'record+transcribe', async () => {
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
      await d.tap({ id: 'diary-record' });
      await liveWaitFor({ id: 'recording-pause' }, { timeoutMs: 30_000 });
      await d.sleep(13_000);
      // Re-tap Finish if the stop screen does not show (layout can shift
      // between the live dump and the tap); retries are recorded.
      let finishRetries = 0;
      for (;;) {
        await liveTap({ id: 'recording-finish' }).catch(() => undefined);
        const shown = await liveWaitFor(
          { id: 'recording-open-entry' },
          { timeoutMs: 15_000 },
        ).then(
          () => true,
          () => false,
        );
        if (shown) break;
        finishRetries += 1;
        if (finishRetries > 3)
          throw new Error('Finish did not stop the recording');
      }
      await liveTap({ id: 'recording-open-entry' });
      await liveWaitFor({ id: 'entry-recording' }, { timeoutMs: 30_000 });
      const outcome = await waitForFinalPass();
      if (outcome === 'failed') throw new Error('final pass failed');
      return { outcome, finishRetries };
    });
    await op(cycle, 'organize', async () => {
      const run = await organize();
      if (run.result !== 'stored') throw new Error(`outcome ${run.result}`);
      await done();
      return { ms: run.ms };
    });
    await op(cycle, 'navigate', async () => {
      await openTab('Organized', 'organized-screen');
      await d.waitFor({ id: 'organized-0' });
      await openTab('Tasks', 'tasks-screen');
    });
    if (cycle % 2 === 0) {
      await op(cycle, 'lock+unlock', async () => {
        await openSettingsHome();
        await d.tap({ id: 'lock-now' });
        await d.waitFor({ id: 'unlock-pin' });
        await d.typeInto({ id: 'unlock-pin' }, PIN);
        await d.hideKeyboard();
        await d.tap({ text: 'Unlock' });
        await d.waitFor({ text: 'Settings' });
      });
    }
    ops.push({ cycle, name: 'memory', ok: true, ...memory() });
  }
  report.end = memory();
  report.cycles = cycle;
} catch (error) {
  report.error = String(error.message).split('\n')[0];
} finally {
  await node?.stop?.();
  const logFile = path.join(args.out, 'device.log');
  try {
    d.saveDeviceLog(logFile);
    const log = fs.readFileSync(logFile, 'utf8');
    report.crashes = (
      log.match(
        /FATAL EXCEPTION|Fatal signal|has died|ANR in com\.audiojournal/g,
      ) ?? []
    ).length;
    report.crashLines = log
      .split('\n')
      .filter(l =>
        /FATAL EXCEPTION|Fatal signal|ANR in com\.audiojournal/.test(l),
      )
      .slice(0, 10);
  } catch (error) {
    report.logError = String(error.message);
  }
  if (node)
    fs.writeFileSync(path.join(args.out, 'companion.log'), node.log.join(''));
  const real = ops.filter(o => o.name !== 'memory');
  report.summary = {
    operations: real.length,
    failed: real.filter(o => !o.ok).length,
    byName: Object.fromEntries(
      [...new Set(real.map(o => o.name))].map(n => [
        n,
        {
          ok: real.filter(o => o.name === n && o.ok).length,
          failed: real.filter(o => o.name === n && !o.ok).length,
        },
      ]),
    ),
  };
  report.ops = ops;
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(args.out, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      cycles: report.cycles,
      summary: report.summary,
      crashes: report.crashes,
      start: report.start,
      end: report.end,
      error: report.error,
    })}\n`,
  );
  process.exitCode =
    report.error || report.summary.failed || report.crashes ? 1 : 0;
}
