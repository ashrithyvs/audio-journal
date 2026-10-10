// AJ-1 device journey for biometric unlock on the emulator (ADR-017):
// - enroll a simulated fingerprint;
// - turn biometric unlock on through a cryptographic BiometricPrompt, and
//   unlock with it;
// - enroll a second finger, which invalidates the biometric key: the app
//   must fall back to the PIN, and the journal stays intact.
// It uses the shared adb/uiautomator driver read-only and honours
// ANDROID_SERIAL.
//
//   ANDROID_SERIAL=emulator-5554 node e2e/aj1/biometric.mjs <apk>

import { performance } from 'node:perf_hooks';

import {
  adb,
  launch,
  PACKAGE,
  scrollTo,
  shell,
  sleep,
  tap,
  typeInto,
  waitFor,
  waitForAny,
} from '../android/lib/device.mjs';

const apk = process.argv[2];
const PIN = '482915';
const DEVICE_PIN = '1111';
const CANARY = 'Biometric canary entry';
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

/** A simulated finger touch on the emulator's sensor. */
function touch(finger) {
  adb('emu', 'finger', 'touch', String(finger));
}

/** Enrolled fingerprints, from the fingerprint service's dump. */
function enrolled() {
  const counts = shell('dumpsys', 'fingerprint').match(/"count":(\d+)/g) ?? [];
  return counts.reduce((sum, item) => sum + Number(item.split(':')[1]), 0);
}

/**
 * Settings' enrollment flow (API 35): confirm the device PIN, step through
 * the introduction (MORE until I AGREE), then touch the sensor until the
 * fingerprint is added. Fails unless the enrolled count goes up.
 */
async function enroll(finger) {
  const before = enrolled();
  shell('am', 'start', '-a', 'android.settings.FINGERPRINT_ENROLL');
  const sensor = { text: 'Touch the sensor' };
  const askPin = { textMatches: /^(Re-enter|Enter) your PIN$/ };
  for (let i = 0; i < 10; i += 1) {
    const { selector } = await waitForAny(
      [
        sensor,
        askPin,
        { textMatches: /^I AGREE$/i },
        { textMatches: /^MORE$/i },
      ],
      { timeoutMs: 15_000 },
    );
    if (selector === sensor) break;
    if (selector === askPin) {
      shell('input', 'text', DEVICE_PIN);
      shell('input', 'keyevent', 'KEYCODE_ENTER');
      await sleep(1_500);
    } else {
      await tap(selector);
    }
  }
  await waitFor(sensor, { timeoutMs: 10_000 });
  for (let i = 0; i < 30 && enrolled() === before; i += 1) {
    touch(finger);
    await sleep(800);
  }
  if (enrolled() <= before) throw new Error('fingerprint not enrolled');
  await tap({ textMatches: /^DONE$/i }, { timeoutMs: 15_000 });
  return enrolled();
}

try {
  await step('device lock and first fingerprint', async () => {
    try {
      shell('locksettings', 'clear', '--old', DEVICE_PIN); // a previous run's lock
    } catch {
      // No device lock yet.
    }
    shell('locksettings', 'set-pin', DEVICE_PIN);
    return { enrolled: await enroll(1) };
  });

  await step('journal with a PIN and an entry', async () => {
    adb('install', '-r', apk);
    shell('pm', 'clear', PACKAGE);
    launch();
    await waitFor({ text: 'Create your private space' }, { timeoutMs: 60_000 });
    await typeInto({ id: 'pin' }, PIN);
    await typeInto({ id: 'pin-confirmation' }, PIN);
    await tap({ text: 'Protect my journal' });
    await waitFor({ id: 'diary-screen' }, { timeoutMs: 60_000 });
    await tap({ id: 'diary-write' });
    await typeInto({ id: 'write-text' }, CANARY);
    await tap({ id: 'write-save' });
    await waitFor(
      { id: 'entry-source-text', text: CANARY },
      { timeoutMs: 30_000 },
    );
    shell('input', 'keyevent', 'KEYCODE_BACK');
  });

  await step('turn on biometric unlock through BiometricPrompt', async () => {
    await tap({ textMatches: /^Settings/ });
    await scrollTo({ id: 'toggle-biometric' });
    await tap({ id: 'toggle-biometric' });
    await sleep(1_500);
    touch(1);
    await waitFor({ text: 'Turn off biometric unlock' }, { timeoutMs: 20_000 });
  });

  await step('lock, then unlock with the fingerprint', async () => {
    await scrollTo({ id: 'lock-now' });
    await tap({ id: 'lock-now' });
    await waitFor({ text: 'Welcome back' }, { timeoutMs: 20_000 });
    await tap({ text: 'Use biometrics' });
    await sleep(1_500);
    touch(1);
    await waitFor({ id: 'diary-screen' }, { timeoutMs: 60_000 });
  });

  await step(
    'a new enrollment invalidates biometrics; the PIN still opens the journal',
    async () => {
      await tap({ textMatches: /^Settings/ });
      await scrollTo({ id: 'lock-now' });
      await tap({ id: 'lock-now' });
      await enroll(2);
      launch();
      await waitFor({ text: 'Welcome back' }, { timeoutMs: 30_000 });
      await typeInto({ id: 'unlock-pin' }, PIN);
      await tap({ text: 'Unlock' });
      await waitFor({ id: 'diary-screen' }, { timeoutMs: 60_000 });
      await waitFor({ text: CANARY }, { timeoutMs: 30_000 });
      await tap({ textMatches: /^Settings/ });
      // The biometric copy was removed and the user is told; turning it on
      // again is the user's choice.
      await scrollTo({ id: 'biometric-invalidated' });
      await scrollTo({ text: 'Turn on biometric unlock' });
      return { notice: 'biometric-invalidated' };
    },
  );
} finally {
  // Leave no device PIN behind: after a cold boot it keeps the user's storage
  // locked until someone enters it, and later runs then hang.
  try {
    shell('locksettings', 'clear', '--old', DEVICE_PIN);
  } catch {
    // No device lock was set.
  }
  for (const result of results) {
    process.stdout.write(`AJ1_BIOMETRIC ${JSON.stringify(result)}\n`);
  }
  const passed = results.filter(result => result.ok).length;
  process.stdout.write(
    `AJ1_BIOMETRIC_SUMMARY ${passed}/${results.length} passed\n`,
  );
  process.exitCode = passed === results.length && results.length === 5 ? 0 : 1;
}
