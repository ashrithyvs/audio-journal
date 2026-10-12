#!/usr/bin/env node
// AJ-2.2 Organized and Tasks journey (ADR-019 A2, ADR-020), through the real
// app UI, the public Hybrid AI SDK, and the node companion:
// - due dates: the companion's engine dates a written entry's tasks, and the
//   app's validator re-derives each date on Hermes from the entry's creation
//   time and the phone's time zone; the host derives them independently;
// - the Tasks view groups by due date against the phone's local date, with
//   Done, Dismiss, and Restore, and opens a task's cited source;
// - a corrected voice line makes its result stale, marked and never hidden;
//   the source opens as cited and as it reads now; Reorganize asks for
//   consent; the task's done state carries over through the correction
//   lineage; History keeps both revisions.
//
//   ANDROID_SERIAL=emulator-5554 node e2e/aj2/organized-tasks.mjs \
//     --apk android/app/build/outputs/apk/e2e/app-e2e.apk [--out <dir>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { anchorDate, deriveDue } from '../../node-companion/src/dates.mjs';
import { pairWithNode, setupPin } from '../android/lib/app.mjs';
import * as d from '../android/lib/device.mjs';
import { liveWaitFor, waitForFinalPass } from '../aj1/lib/liveScreen.mjs';
import { startCompanion } from './lib/companion.mjs';
import { done, organize, writeEntry } from './lib/flows.mjs';
import { recordSample, textsWithin } from './lib/voice.mjs';

const { values: args } = parseArgs({
  options: {
    apk: { type: 'string' },
    out: {
      type: 'string',
      default: fs.mkdtempSync(path.join(os.tmpdir(), 'aj2-organized-')),
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

// One paragraph per task: each is its own unit (contract §2).
const PARAGRAPHS = [
  ['I need to pay the rent today.', 'Pay the rent today.', 'today'],
  ['I need to call the bank tomorrow.', 'Call the bank tomorrow.', 'tomorrow'],
  [
    'Remember to send the invoice by Friday.',
    'Send the invoice by Friday.',
    'Friday',
  ],
  [
    'We should book the hall on 14 November.',
    'Book the hall on 14 November.',
    '14 November',
  ],
  ['I need to water the plants.', 'Water the plants.'],
];
const CORRECTED = 'I need to call the plumber.';
const RECORRECTED = 'So I need to call the plumber.';
const VOICE_TASK = 'Call the plumber.';
// Entry phrases that must never reach a log. Whole phrases: single words
// such as "rent" occur inside system identifiers ("currentUser").
const PRIVATE = [
  'pay the rent',
  'the invoice',
  'water the plants',
  'call the plumber',
  'fellow americans',
];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
/** The app's `formatCalendarDate`, re-stated: "Fri 23 Oct 2026". */
function calendar(iso) {
  const [y, m, day] = iso.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
  return `${WEEKDAYS[weekday]} ${day} ${MONTHS[m - 1]} ${y}`;
}

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

/**
 * Opens a tab and pops its stack to the list. Card headings can read the
 * same as a tab ("Tasks"), so tap the lowest node with that text: the tab bar.
 */
async function openTab(name, screenId) {
  const tapTab = () => {
    const bar = d
      .dump()
      .filter(n => n.text === name && n.bounds)
      .sort((a, b) => b.bounds[1] - a.bounds[1])[0];
    if (!bar) throw new Error(`no ${name} tab`);
    const [x0, y0, x1, y1] = bar.bounds;
    d.shell(
      'input',
      'tap',
      String(Math.round((x0 + x1) / 2)),
      String(Math.round((y0 + y1) / 2)),
    );
  };
  tapTab();
  await d.sleep(500);
  for (let i = 0; i < 3 && !d.find(d.dump(), { id: screenId }); i += 1) {
    tapTab();
    await d.sleep(500);
  }
  await d.waitFor({ id: screenId });
  await d.scrollToTop();
}

/** A row's text, scrolling to it. */
async function rowText(id) {
  const text = await d.readText({ id }, { maxSwipes: 8 });
  expect(text !== undefined, `no ${id}`);
  return text;
}

let timeZone = '';
let today = '';
const due = new Map();

try {
  await step(
    'T00',
    'install the e2e build, PIN, companion, pairing',
    async () => {
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
      node = await startCompanion({ name: 'AJ Companion' });
      await pairWithNode(node);
      timeZone = d.shell('getprop', 'persist.sys.timezone').trim() || 'UTC';
      return { timeZone };
    },
  );

  await step(
    'T01',
    'organize a dated written entry; Hermes re-derives every due date',
    async () => {
      const before = Date.now();
      await writeEntry({ text: PARAGRAPHS.map(([p]) => p).join('\n\n') });
      const after = Date.now();
      // The entry's creation time lies between the two; its local date must
      // not straddle midnight, or the expected dates are indeterminate.
      const [a, b] = [before, after].map(ms =>
        anchorDate(new Date(ms).toISOString(), timeZone),
      );
      expect(
        a.y === b.y && a.m === b.m && a.d === b.d,
        'the entry was saved across local midnight; rerun',
      );
      today = `${a.y}-${String(a.m).padStart(2, '0')}-${String(a.d).padStart(
        2,
        '0',
      )}`;
      for (const [paragraph, task, phrase] of PARAGRAPHS) {
        if (!phrase) continue;
        const at = paragraph.indexOf(phrase);
        const derived = deriveDue(
          paragraph,
          at,
          at + phrase.length,
          new Date(before).toISOString(),
          timeZone,
        );
        expect(derived, `the host derives no date for "${phrase}"`);
        due.set(task, derived.date);
      }
      const run = await organize();
      // An app validator that disagreed with the engine on any date would
      // reject the whole result as RESULT_DUE.
      expect(
        run.result === 'stored',
        `outcome ${run.result}; on screen: ${d.screenSummary()}`,
      );
      evidence.push({ step: 'T01', ui: run.ui });
      await done();
      return { today, timeZone, due: Object.fromEntries(due) };
    },
  );

  await step('T02', 'Tasks groups by due date against today', async () => {
    await openTab('Tasks', 'tasks-screen');
    const rows = [];
    const expected = PARAGRAPHS.map(([, task]) => {
      const date = due.get(task);
      const group = !date
        ? 'undated'
        : date < today
        ? 'overdue'
        : date === today
        ? 'today'
        : 'upcoming';
      return { task, date, group };
    }).sort((x, y) => (x.date ?? '9999').localeCompare(y.date ?? '9999'));
    const index = new Map();
    for (const { task, date, group } of expected) {
      const i = index.get(group) ?? 0;
      index.set(group, i + 1);
      const id = `task-${group}-${i}`;
      const text = await rowText(`${id}-text`);
      const meta = await rowText(`${id}-meta`);
      expect(text === task, `${id} reads "${text}", expected "${task}"`);
      const label = !date
        ? undefined
        : date === today
        ? 'Due today'
        : date < today
        ? `Overdue · ${calendar(date)}`
        : `Due ${calendar(date)}`;
      if (label) {
        expect(meta.endsWith(label), `${id} meta "${meta}", expected ${label}`);
      }
      rows.push({ id, text, meta });
    }
    evidence.push({ step: 'T02', rows });
    return { rows };
  });

  await step('T03', 'Done, Dismiss, and Restore', async () => {
    const first = await rowText('task-today-0-text');
    await d.tap({ id: 'task-today-0-done' });
    await d.findScrolling({ id: 'task-done-0-text', text: first });
    await d.tap({ id: 'task-done-0-restore' });
    await d.findScrolling({ id: 'task-today-0-text', text: first });
    await d.tap({ id: 'task-undated-0-dismiss' });
    await d.findScrolling({
      id: 'task-dismissed-0-text',
      text: 'Water the plants.',
    });
    await d.tap({ id: 'task-dismissed-0-restore' });
    await d.findScrolling({
      id: 'task-undated-0-text',
      text: 'Water the plants.',
    });
  });

  await step(
    'T04',
    "a task's source names its entry and opens the cited sentence",
    async () => {
      await d.scrollToTop();
      const task = 'Send the invoice by Friday.';
      const row = PARAGRAPHS.findIndex(([, t]) => t === task);
      const id = await rowWith(
        due.get(task) === today ? 'today' : 'upcoming',
        task,
      );
      await d.findScrolling({ id: `${id}-source` });
      const label = textsWithin(`${id}-source`).join(' ');
      const [y, m, day] = today.split('-').map(Number);
      expect(
        label.startsWith(`Source · ${MONTHS[m - 1]} ${day},`) &&
          label.endsWith(`· paragraph ${row + 1}`),
        `source label "${label}" (entry ${y}-${m}-${day})`,
      );
      await d.tap({ id: `${id}-source` });
      await d.waitFor({ id: 'cited-source' }, { timeoutMs: 20_000 });
      const excerpt = d.textOf({ id: 'cited-text' });
      expect(
        excerpt === PARAGRAPHS[row][0],
        `cited "${excerpt}", expected "${PARAGRAPHS[row][0]}"`,
      );
      d.back();
      await d.waitFor({ id: 'tasks-screen' });
      return { label };
    },
  );

  await step(
    'T05',
    'record the sample, correct its first line, organize it',
    async () => {
      await recordSample();
      const outcome = await waitForFinalPass();
      expect(outcome !== 'failed', `final pass ${outcome}`);
      await liveWaitFor({ id: 'transcript-kind-final' }, { timeoutMs: 60_000 });
      await correctLine(CORRECTED);
      const run = await organize();
      expect(
        run.result === 'stored',
        `outcome ${run.result}; on screen: ${d.screenSummary()}`,
      );
      await done();
    },
  );

  await step('T06', 'mark the voice task done', async () => {
    await openTab('Tasks', 'tasks-screen');
    const id = await rowWith('undated', VOICE_TASK);
    await d.tap({ id: `${id}-done` });
    await rowWith('done', VOICE_TASK);
  });

  await step(
    'T07',
    'a second correction marks the result stale; the source opens as cited',
    async () => {
      await d.tap({ text: 'Diary' });
      await d.waitFor({ id: 'entry-detail' });
      await correctLine(RECORRECTED);
      await openTab('Organized', 'organized-screen');
      await d.findScrolling({ id: 'organized-0-stale' });
      await d.findScrolling({ id: 'organized-0-stale-task-0' });
      const item = await rowText('organized-0-item-task-0');
      expect(item === `• ${VOICE_TASK}`, `stale item reads "${item}"`);
      await d.tap({ id: 'organized-0-source-task-0' });
      await d.waitFor({ id: 'cited-edited' }, { timeoutMs: 20_000 });
      const cited = d.textOf({ id: 'cited-text' });
      const now = d.textOf({ id: 'cited-now' });
      expect(cited === CORRECTED, `as cited: "${cited}"`);
      expect(now === RECORRECTED, `as it reads now: "${now}"`);
      d.back();
      await d.waitFor({ id: 'organized-screen' });
      await openTab('Tasks', 'tasks-screen');
      const id = await rowWith('done', VOICE_TASK);
      await d.findScrolling({ id: `${id}-stale` });
      return { cited, now };
    },
  );

  await step(
    'T08',
    'Reorganize asks for consent; the done state carries over',
    async () => {
      await openTab('Organized', 'organized-screen');
      const jobs = (await node.stats()).jobs;
      await d.tap({ id: 'organized-0-reorganize' });
      await d.findScrolling({ id: 'organize-consent' });
      await d.sleep(2_000);
      expect(
        (await node.stats()).jobs === jobs,
        'Reorganize sent a request before consent',
      );
      await d.tap({ id: 'organize-confirm' });
      await d.findScrolling({ id: 'organize-stored' }, { timeoutMs: 90_000 });
      await d.tap({ id: 'organize-done' });
      await d.scrollToTop();
      const scope = await rowText('organized-0-scope');
      expect(/revision 2/.test(scope), `scope reads "${scope}"`);
      await d.waitFor({ id: 'organized-0-stale' }, { absent: true });
      await openTab('Tasks', 'tasks-screen');
      const id = await rowWith('done', VOICE_TASK);
      const meta = await rowText(`${id}-meta`);
      expect(/kept from earlier/.test(meta), `meta "${meta}"`);
      return { scope, meta };
    },
  );

  await step('T09', 'History keeps both revisions', async () => {
    await openTab('Organized', 'organized-screen');
    await d.tap({ id: 'organized-0-history' });
    await d.waitFor({ id: 'organized-history' });
    await d.findScrolling({ id: 'history-revision-2' });
    await d.findScrolling({ id: 'history-revision-1-stale' });
    evidence.push({ step: 'T09', ui: d.snapshot() });
    d.back();
  });

  await step('T10', 'privacy: no entry words in either log', async () => {
    const logFile = path.join(args.out, 'device.log');
    d.saveDeviceLog(logFile);
    const deviceLog = fs.readFileSync(logFile, 'utf8').toLowerCase();
    const companionLog = node.log.join('').toLowerCase();
    fs.writeFileSync(path.join(args.out, 'companion.log'), node.log.join(''));
    for (const words of PRIVATE) {
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
  process.exitCode = failed || results.length < 11 ? 1 : 0;
}

/** Replaces the open entry's first transcript line with `text`. */
async function correctLine(text) {
  await d.tap({ id: 'transcript-text-0' });
  await d.waitFor({ id: 'transcript-edit-0' });
  await d.clearField({ id: 'transcript-edit-0' });
  if (!(await d.pasteInto({ id: 'transcript-edit-0' }, text))) {
    throw new Error('the correction did not paste');
  }
  await d.hideKeyboard();
  await d.tap({ id: 'transcript-save-0' });
  // The line's text is drawn by a child of `transcript-text-0`.
  await d.waitFor({ id: 'transcript-edit-0' }, { absent: true });
  await d.findScrolling({ text });
}

/** The row ID of `task` in `group`, scrolling to find it. */
async function rowWith(group, task) {
  for (let i = 0; i < 12; i += 1) {
    const id = `task-${group}-${i}`;
    const text = await d.readText({ id: `${id}-text` }, { maxSwipes: 6 });
    if (text === undefined) break;
    if (text === task) return id;
  }
  throw new Error(`"${task}" is not in ${group}`);
}
