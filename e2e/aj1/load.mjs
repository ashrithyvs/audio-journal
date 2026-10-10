// AJ-1 device load journeys (roadmap §3; LLD §5.2 and §6): repeated capture
// sessions and long recordings, each followed by its on-device final pass.
// Per session it records:
// - the requested and captured duration;
// - finish latency (Finish tapped until the entry can be opened);
// - final-pass wall time, from Finish until the transcript is final or empty;
// - app RSS from /proc (never `dumpsys meminfo`, which perturbs the run);
// - battery temperature.
// Run it only inside an exclusive-run window. Numbers are emulator
// development measurements, not budgets. Ticking screens are read with
// lib/liveScreen.mjs, which never waits for the UI to idle.
// The emulator's microphone input (silence under -no-audio) makes the final
// pass an "empty" result; that still exercises the full decode path.
//
//   ANDROID_SERIAL=emulator-5554 node e2e/aj1/load.mjs <apk> [--sessions 5] [--minutes 2] [--fresh]

import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import {
  adb,
  launch,
  PACKAGE,
  shell,
  sleep,
  tap,
  typeInto,
  waitFor,
} from '../android/lib/device.mjs';

import {
  liveTap,
  liveTextOf,
  liveWaitFor,
  waitForFinalPass,
} from './lib/liveScreen.mjs';

const args = process.argv.slice(2);
const apk = args[0];
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? Number(args[at + 1]) : fallback;
};
const sessions = option('sessions', 5);
const minutes = option('minutes', 2);
const PIN = '482915';
const out = [];

const rssKb = () => {
  const pid = shell('pidof', PACKAGE).trim();
  if (!pid) return null;
  const status = shell('cat', `/proc/${pid}/status`);
  return Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? NaN);
};
const temperature = () =>
  Number(/temperature: (\d+)/.exec(shell('dumpsys', 'battery'))?.[1] ?? NaN) /
  10;
const seconds = text => {
  const match = /(\d+):(\d\d)/.exec(text ?? '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
};

if (args.includes('--fresh')) {
  adb('install', '-r', apk);
  shell('pm', 'clear', PACKAGE);
  shell('pm', 'grant', PACKAGE, 'android.permission.RECORD_AUDIO');
  launch();
  await waitFor({ text: 'Create your private space' }, { timeoutMs: 60_000 });
  await typeInto({ id: 'pin' }, PIN);
  await typeInto({ id: 'pin-confirmation' }, PIN);
  await tap({ text: 'Protect my journal' });
} else {
  launch();
  await waitFor({ text: 'Welcome back' }, { timeoutMs: 60_000 });
  await typeInto({ id: 'unlock-pin' }, PIN);
  await tap({ text: 'Unlock' });
}
await liveWaitFor({ id: 'diary-screen' }, { timeoutMs: 60_000 });

for (let session = 1; session <= sessions; session += 1) {
  const record = { session, requestedMinutes: minutes };
  await liveTap({ id: 'diary-record' });
  await liveWaitFor({ id: 'recording-pause' }, { timeoutMs: 30_000 });
  record.rssStartKb = rssKb();
  const end = Date.now() + minutes * 60_000;
  let peak = record.rssStartKb ?? 0;
  while (Date.now() < end) {
    await sleep(Math.min(30_000, end - Date.now()));
    peak = Math.max(peak, rssKb() ?? 0);
  }
  record.rssPeakDuringCaptureKb = peak;
  record.capturedSeconds = seconds(liveTextOf({ id: 'recording-timer' }));
  const finishing = performance.now();
  await liveTap({ id: 'recording-finish' });
  await liveWaitFor({ id: 'recording-open-entry' }, { timeoutMs: 120_000 });
  record.finishMs = Math.round(performance.now() - finishing);
  await liveTap({ id: 'recording-open-entry' });
  const outcome = await waitForFinalPass({
    timeoutMs: Math.max(600_000, minutes * 60_000 * 2),
  });
  // The final pass is queued when the recording is saved, so it is timed
  // from Finish.
  record.finalPassAfterFinishMs = Math.round(performance.now() - finishing);
  record.finalPass = outcome;
  record.rssAfterPassKb = rssKb();
  record.temperatureC = temperature();
  out.push(record);
  process.stdout.write(`AJ1_LOAD ${JSON.stringify(record)}\n`);
  shell('input', 'keyevent', 'KEYCODE_BACK');
  await liveWaitFor({ id: 'diary-screen' }, { timeoutMs: 20_000 });
}

const file = `aj1-load-${Date.now()}.json`;
writeFileSync(
  file,
  JSON.stringify({ sessions, minutes, results: out }, null, 2),
);
process.stdout.write(
  `AJ1_LOAD_SUMMARY ${out.length}/${sessions} sessions · ${file}\n`,
);
process.exitCode =
  out.length === sessions && out.every(r => r.finalPass !== 'failed') ? 0 : 1;
