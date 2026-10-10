// AJ-1 device smoke on the real native vault and SQLCipher store, over the
// release build (bundled JS, R8). It uses the shared adb/uiautomator driver
// read-only and honours ANDROID_SERIAL. Evidence is UI-hierarchy text,
// because FLAG_SECURE blocks screenshots.
//
//   ANDROID_SERIAL=emulator-5554 node e2e/aj1/smoke.mjs <app-release.apk>

import { performance } from 'node:perf_hooks';

import {
  adb,
  forceStop,
  launch,
  PACKAGE,
  shell,
  tap,
  typeInto,
  waitFor,
} from '../android/lib/device.mjs';

const apk = process.argv[2];
const PIN = '482915';
const ENTRY = 'Device smoke entry';
const results = [];

async function step(name, work) {
  const started = performance.now();
  try {
    await work();
    results.push({
      name,
      ok: true,
      ms: Math.round(performance.now() - started),
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

async function unlock(pin) {
  await typeInto({ id: 'unlock-pin' }, pin);
  await tap({ text: 'Unlock' });
}

try {
  await step('fresh install', async () => {
    adb('install', '-r', apk);
    shell('pm', 'clear', PACKAGE);
    launch();
    await waitFor({ text: 'Create your private space' }, { timeoutMs: 60_000 });
  });
  await step('set PIN in the native vault', async () => {
    await typeInto({ id: 'pin' }, PIN);
    await typeInto({ id: 'pin-confirmation' }, PIN);
    await tap({ text: 'Protect my journal' });
    await waitFor(
      { text: 'What do you want to remember?' },
      { timeoutMs: 60_000 },
    );
  });
  await step('write an entry into the encrypted store', async () => {
    await tap({ id: 'diary-write' });
    await typeInto({ id: 'write-text' }, ENTRY);
    await tap({ id: 'write-save' });
    await waitFor(
      { id: 'entry-source-text', text: ENTRY },
      { timeoutMs: 30_000 },
    );
  });
  await step('lock from Settings', async () => {
    await tap({ text: 'Settings' });
    await tap({ id: 'lock-now' });
    await waitFor({ text: 'Welcome back' });
  });
  await step('wrong PIN is refused', async () => {
    await unlock('000000');
    await waitFor({ text: 'That PIN is not correct.' }, { timeoutMs: 30_000 });
  });
  await step('process death keeps the vault locked', async () => {
    forceStop();
    launch();
    await waitFor({ text: 'Welcome back' }, { timeoutMs: 60_000 });
  });
  await step('unlock after restart shows the persisted entry', async () => {
    await unlock(PIN);
    await waitFor({ text: ENTRY }, { timeoutMs: 60_000 });
  });
} finally {
  for (const result of results) {
    process.stdout.write(`AJ1_SMOKE ${JSON.stringify(result)}\n`);
  }
  const passed = results.filter(result => result.ok).length;
  process.stdout.write(
    `AJ1_SMOKE_SUMMARY ${passed}/${results.length} passed\n`,
  );
  process.exitCode = passed === 7 ? 0 : 1;
}
