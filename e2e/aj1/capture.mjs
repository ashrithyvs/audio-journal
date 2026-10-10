// AJ-1 device journey for voice capture on the native AJR1 recorder:
// - record, pause, resume, and finish;
// - play back the sealed recording, and run the on-device final pass;
// - keep a capture that leaving the app interrupted (ADR-017, owner
//   decision 2026-10-10);
// - discard only after confirmation.
// It uses the shared adb/uiautomator driver read-only and honours
// ANDROID_SERIAL. Screens that tick every second (the recording timer, the
// playback position) never idle, so those are read with lib/liveScreen.mjs.
// Evidence is UI-hierarchy text, because FLAG_SECURE blocks screenshots.
//
//   ANDROID_SERIAL=emulator-5554 node e2e/aj1/capture.mjs <apk>

import { performance } from 'node:perf_hooks';

import {
  adb,
  forceStop,
  home,
  launch,
  PACKAGE,
  shell,
  sleep,
  tap,
  typeInto,
  waitFor,
} from '../android/lib/device.mjs';

import {
  liveDump,
  liveTap,
  liveTextOf,
  liveWaitFor,
  waitForFinalPass,
} from './lib/liveScreen.mjs';

const apk = process.argv[2];
const PIN = '482915';
const results = [];

async function step(name, work) {
  const started = performance.now();
  try {
    const detail = await work();
    results.push({
      name,
      ok: true,
      ms: Math.round(performance.now() - started),
      ...detail,
    });
  } catch (error) {
    results.push({
      name,
      ok: false,
      error: String(error.message).split('\n')[0],
    });
    throw error;
  }
}

// Diary rows read "<time> · Voice · <duration>"; the newest is first.
const VOICE_ROW = { textMatches: / · Voice · / };
const voiceRows = () =>
  liveDump().filter(node => VOICE_ROW.textMatches.test(node.text)).length;

const seconds = text => {
  const match = /(\d+):(\d\d)/.exec(text ?? '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
};

async function unlock() {
  await typeInto({ id: 'unlock-pin' }, PIN);
  await tap({ text: 'Unlock' });
  // A final pass queued at unlock may keep the diary busy.
  await liveWaitFor({ id: 'diary-screen' }, { timeoutMs: 60_000 });
}

try {
  await step('fresh install with the microphone granted', async () => {
    adb('install', '-r', apk);
    shell('pm', 'clear', PACKAGE);
    shell('pm', 'grant', PACKAGE, 'android.permission.RECORD_AUDIO');
    launch();
    await waitFor({ text: 'Create your private space' }, { timeoutMs: 60_000 });
    await typeInto({ id: 'pin' }, PIN);
    await typeInto({ id: 'pin-confirmation' }, PIN);
    await tap({ text: 'Protect my journal' });
    await waitFor({ id: 'diary-screen' }, { timeoutMs: 60_000 });
  });

  await step('record, pause, resume, and finish', async () => {
    await tap({ id: 'diary-record' });
    await liveWaitFor({ id: 'recording-pause' }, { timeoutMs: 30_000 });
    await sleep(5_000);
    await liveTap({ id: 'recording-pause' });
    await liveWaitFor({ id: 'recording-resume' });
    const paused = seconds(liveTextOf({ id: 'recording-timer' }));
    await sleep(2_000);
    // A paused capture does not advance.
    if (seconds(liveTextOf({ id: 'recording-timer' })) !== paused) {
      throw new Error('timer advanced while paused');
    }
    await liveTap({ id: 'recording-resume' });
    await sleep(3_000);
    await liveTap({ id: 'recording-finish' });
    await liveWaitFor({ id: 'recording-open-entry' }, { timeoutMs: 30_000 });
    const capturedSeconds = seconds(liveTextOf({ id: 'recording-timer' }));
    if (!(capturedSeconds >= 7))
      throw new Error(`captured only ${capturedSeconds} s`);
    return { capturedSeconds };
  });

  await step('open the entry and play the sealed recording', async () => {
    await liveTap({ id: 'recording-open-entry' });
    await liveWaitFor({ id: 'entry-recording' }, { timeoutMs: 30_000 });
    await liveTap({ id: 'entry-play' });
    await liveWaitFor({ text: 'Pause' }, { timeoutMs: 10_000 });
    await sleep(2_500);
    const position = seconds(liveTextOf({ id: 'entry-position' }));
    if (!(position >= 1))
      throw new Error(`playback did not advance (${position})`);
    await liveTap({ text: 'Pause' });
    return { playedSeconds: position };
  });

  await step('the on-device final pass completes', async () => {
    const outcome = await waitForFinalPass();
    if (outcome === 'failed') throw new Error('final pass failed');
    return { outcome };
  });

  await step(
    'leaving the app mid-capture keeps the audio as a ready entry',
    async () => {
      shell('input', 'keyevent', 'KEYCODE_BACK');
      await liveWaitFor({ id: 'diary-screen' }, { timeoutMs: 20_000 });
      const before = voiceRows();
      await liveTap({ id: 'diary-record' });
      await liveWaitFor({ id: 'recording-pause' }, { timeoutMs: 30_000 });
      await sleep(4_000);
      home(); // pauses, seals, and locks; the recording key is zeroed
      await sleep(2_000);
      launch();
      await waitFor({ text: 'Welcome back' }, { timeoutMs: 30_000 });
      await unlock();
      // Reconciliation promoted it to a ready entry: open the newest one.
      const after = voiceRows();
      if (after !== before + 1)
        throw new Error(`voice entries ${before} -> ${after}`);
      await liveTap(VOICE_ROW, { timeoutMs: 30_000 });
      await liveWaitFor({ id: 'entry-recovered' }, { timeoutMs: 30_000 });
      await liveWaitFor({ id: 'entry-play' }, { timeoutMs: 10_000 });
      return { voiceEntries: after };
    },
  );

  await step('discard asks first, then leaves no entry', async () => {
    forceStop();
    launch();
    await unlock();
    const before = voiceRows();
    await liveTap({ id: 'diary-record' });
    await liveWaitFor({ id: 'recording-pause' }, { timeoutMs: 30_000 });
    await sleep(2_000);
    await liveTap({ id: 'recording-discard' });
    // Nothing is discarded until the user confirms.
    await liveWaitFor({ id: 'discard-confirm' });
    await liveWaitFor({ id: 'recording-timer' });
    await liveTap({ id: 'discard-confirm-yes' });
    await liveTap({ id: 'recording-done' }, { timeoutMs: 20_000 });
    await liveWaitFor({ id: 'diary-screen' }, { timeoutMs: 20_000 });
    const after = voiceRows();
    if (after !== before)
      throw new Error(`voice entries ${before} -> ${after}`);
    return { voiceEntries: after };
  });
} finally {
  for (const result of results) {
    process.stdout.write(`AJ1_CAPTURE ${JSON.stringify(result)}\n`);
  }
  const passed = results.filter(result => result.ok).length;
  process.stdout.write(
    `AJ1_CAPTURE_SUMMARY ${passed}/${results.length} passed\n`,
  );
  process.exitCode = passed === results.length && results.length === 6 ? 0 : 1;
}
