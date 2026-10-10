// AJ-1 device journey: encrypted backup, app-data clear, and restore
// (backup-and-restore.md §2 and §8; owner decisions of 2026-10-10). Both
// system pickers (DocumentsUI) are driven through the UI; the recovery key is
// read from the screen and confirmed by the three-word challenge. Evidence is
// UI-hierarchy text, because FLAG_SECURE blocks screenshots. The recovery
// words are never printed.
//
//   ANDROID_SERIAL=emulator-5554 node e2e/aj1/backup.mjs <apk>

import { performance } from 'node:perf_hooks';

import {
  adb,
  dump,
  find,
  launch,
  PACKAGE,
  scrollTo,
  shell,
  sleep,
  tap,
  textOf,
  typeInto,
  waitFor,
  waitForAny,
} from '../android/lib/device.mjs';

import {
  liveTap,
  liveTextOf,
  liveWaitFor,
  waitForFinalPass,
} from './lib/liveScreen.mjs';

const apk = process.argv[2];
const PIN = '482915';
const NEW_PIN = '730541';
const CANARY = 'Backup canary entry';
const results = [];
let words = [];
let savedName;

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

async function createPin(pin) {
  await waitFor({ text: 'Create your private space' }, { timeoutMs: 60_000 });
  await typeInto({ id: 'pin' }, pin);
  await typeInto({ id: 'pin-confirmation' }, pin);
  await tap({ text: 'Protect my journal' });
  await waitFor({ id: 'diary-screen' }, { timeoutMs: 60_000 });
}

async function openBackup() {
  await tap({ textMatches: /^Settings/ });
  await tap({ id: 'open-backup' });
  await waitFor({ id: 'backup-screen' }, { timeoutMs: 20_000 });
}

try {
  await step('journal with a written entry and a voice entry', async () => {
    adb('install', '-r', apk);
    shell('pm', 'clear', PACKAGE);
    shell('pm', 'grant', PACKAGE, 'android.permission.RECORD_AUDIO');
    launch();
    await createPin(PIN);
    await tap({ id: 'diary-write' });
    await typeInto({ id: 'write-text' }, CANARY);
    await tap({ id: 'write-save' });
    await waitFor(
      { id: 'entry-source-text', text: CANARY },
      { timeoutMs: 30_000 },
    );
    shell('input', 'keyevent', 'KEYCODE_BACK');
    // A short recording; its final pass settles before the backup starts.
    await liveTap({ id: 'diary-record' });
    await liveWaitFor({ id: 'recording-pause' }, { timeoutMs: 30_000 });
    await sleep(4_000);
    await liveTap({ id: 'recording-finish' });
    await liveTap({ id: 'recording-open-entry' }, { timeoutMs: 30_000 });
    if ((await waitForFinalPass()) === 'failed')
      throw new Error('final pass failed');
    shell('input', 'keyevent', 'KEYCODE_BACK');
    await liveWaitFor({ id: 'diary-screen' }, { timeoutMs: 20_000 });
  });

  await step('create a backup protected by a recovery key', async () => {
    await openBackup();
    await tap({ id: 'backup-create' });
    await tap({ id: 'backup-use-key' }, { timeoutMs: 60_000 });
    await waitFor({ id: 'backup-word-24' }, { timeoutMs: 20_000 });
    const nodes = dump();
    words = Array.from({ length: 24 }, (_, i) =>
      (find(nodes, { id: `backup-word-${i + 1}` })?.text ?? '').replace(
        /^\d+\.\s*/,
        '',
      ),
    );
    if (words.some(word => !/^[a-z]+$/.test(word)))
      throw new Error('could not read the recovery key');
    await tap({ id: 'backup-key-written' });
    for (let i = 0; i < 3; i += 1) {
      const label = find(dump(), { id: `backup-challenge-${i}` })?.desc ?? '';
      const position = Number(/Word (\d+)/.exec(label)?.[1]);
      if (!position) throw new Error(`no challenge position in "${label}"`);
      await typeInto({ id: `backup-challenge-${i}` }, words[position - 1]);
    }
    await tap({ id: 'backup-challenge-continue' });
    await waitFor({ id: 'backup-save' }, { timeoutMs: 180_000 });
  });

  await step(
    'save through the system picker; the destination verifies',
    async () => {
      await tap({ id: 'backup-save' });
      // DocumentsUI save dialog: confirm the suggested name.
      await tap({ textMatches: /^save$/i }, { timeoutMs: 30_000 });
      await waitFor({ id: 'backup-done' }, { timeoutMs: 120_000 });
      // The suggested name survives the picker, without "-incomplete".
      const named = await waitFor({
        textMatches: /^AudioJournal-\d{4}-\d\d-\d\d-\d{4}\.ajbackup · /,
      });
      savedName = named.text.split(' · ')[0];
      if (find(dump(), { id: 'backup-incomplete' }))
        throw new Error('backup marked incomplete');
      return { savedName };
    },
  );

  await step(
    'app data cleared: a new, empty journal with a new PIN',
    async () => {
      shell('pm', 'clear', PACKAGE);
      launch();
      await createPin(NEW_PIN);
      await waitFor({ id: 'diary-empty' }, { timeoutMs: 30_000 });
    },
  );

  await step(
    'restore through the system picker with the recovery key',
    async () => {
      await openBackup();
      await tap({ id: 'backup-restore' });
      await tap({ id: 'restore-pick' }, { timeoutMs: 30_000 });
      // DocumentsUI open dialog: the backup is among recent files.
      await tap(
        { textMatches: /^AudioJournal-.*\.ajbackup$/ },
        { timeoutMs: 30_000 },
      );
      await waitFor({ id: 'restore-secret-input' }, { timeoutMs: 30_000 });
      await typeInto({ id: 'restore-secret-input' }, words.join(' '));
      await tap({ id: 'restore-open' });
      await waitFor({ id: 'restore-counts' }, { timeoutMs: 180_000 });
      const counts = textOf({ id: 'restore-counts' });
      if (!/^2 entries · 1 recording · \d+ KB of audio\./.test(counts ?? ''))
        throw new Error(`unexpected preview: ${counts}`);
      await tap({ id: 'restore-confirm' });
      await waitFor({ id: 'restore-pin-input' }, { timeoutMs: 180_000 });
      await typeInto({ id: 'restore-pin-input' }, NEW_PIN);
      await tap({ id: 'restore-activate' });
      await waitFor({ text: 'Welcome back' }, { timeoutMs: 60_000 });
      return { counts };
    },
  );

  await step('unlock opens the restored journal', async () => {
    await typeInto({ id: 'unlock-pin' }, NEW_PIN);
    await tap({ text: 'Unlock' });
    const found = await waitForAny(
      [{ text: CANARY }, { textMatches: new RegExp(CANARY) }],
      {
        timeoutMs: 60_000,
      },
    );
    if (!found) throw new Error('restored entry not shown');
  });

  await step('the restored recording plays', async () => {
    await liveTap({ textMatches: / · Voice · / }, { timeoutMs: 30_000 });
    await liveTap({ id: 'entry-play' }, { timeoutMs: 30_000 });
    await liveWaitFor({ text: 'Pause' }, { timeoutMs: 10_000 });
    await sleep(2_000);
    const position = liveTextOf({ id: 'entry-position' }) ?? '';
    if (!/^0:0[1-9]/.test(position))
      throw new Error(`playback did not advance (${position})`);
    await liveTap({ text: 'Pause' });
    shell('input', 'keyevent', 'KEYCODE_BACK');
    await liveWaitFor({ id: 'diary-screen' }, { timeoutMs: 20_000 });
    return { position };
  });

  await step('the old PIN no longer opens it', async () => {
    await tap({ textMatches: /^Settings/ });
    await scrollTo({ id: 'lock-now' });
    await tap({ id: 'lock-now' });
    await typeInto({ id: 'unlock-pin' }, PIN);
    await tap({ text: 'Unlock' });
    await waitFor({ text: 'That PIN is not correct.' }, { timeoutMs: 30_000 });
    await sleep(500);
  });
} finally {
  for (const result of results) {
    process.stdout.write(`AJ1_BACKUP ${JSON.stringify(result)}\n`);
  }
  const passed = results.filter(result => result.ok).length;
  process.stdout.write(
    `AJ1_BACKUP_SUMMARY ${passed}/${results.length} passed\n`,
  );
  process.exitCode = passed === results.length && results.length === 8 ? 0 : 1;
}
