#!/usr/bin/env node
// AJ-2 device suite: journal.organize@1 end to end through the real app UI,
// the packaged Hybrid AI SDK (public API only), and the Audio Journal node
// companion (node-companion/), reached over `adb reverse`.
//
//   ANDROID_SERIAL=emulator-5554 node e2e/aj2/organize-e2e.mjs --apk <app.apk>
//     [--out <dir>] [--fixture <nsd-fixture.apk>] [--only O00,O01]
//
// Steps:
//   O00 install, PIN, companion, pairing with compared codes
//   O01 consent first (decline sends nothing), then a stored result
//   O02 retry of an identical request: recognised, nothing sent
//   O03 cancel during a run: nothing stored
//   O04 node down: failure, nothing stored; node back: stored, Connected
//   O05 deadline: the node is too slow, nothing stored
//   O06 boundary: a ~60 KB request and a completed message of exactly
//       61,440 bytes accepted by the SDK; an over-cap request refused
//   O07 load: sequential organize runs, latency
//   O08 privacy: no journal text in the device log or the companion log;
//       every TLS handshake on the accepted profile
// Evidence is UI-hierarchy text and companion counts (FLAG_SECURE blocks
// screenshots). Exits non-zero on any failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

import { pairWithNode, setupPin } from '../android/lib/app.mjs';
import * as d from '../android/lib/device.mjs';
import { startCompanion } from './lib/companion.mjs';
import { connectionLabel, done, organize, writeEntry } from './lib/flows.mjs';

const { values: args } = parseArgs({
  options: {
    apk: { type: 'string' },
    out: {
      type: 'string',
      default: fs.mkdtempSync(path.join(os.tmpdir(), 'aj2-e2e-')),
    },
    fixture: {
      type: 'string',
      default: path.resolve(
        import.meta.dirname,
        '../../../audio-journal/e2e/android/nsd-fixture/build/outputs/apk/debug/aj-nsd-fixture-debug.apk',
      ),
    },
    only: { type: 'string', default: '' },
    'load-runs': { type: 'string', default: '5' },
    // After a fixed packaged SDK (SDK-AJ-5): require the node-side cancel
    // and a clean retry instead of recording the known defect.
    'expect-node-cancel': { type: 'boolean', default: false },
  },
});
if (!process.env.ANDROID_SERIAL) {
  throw new Error('ANDROID_SERIAL must name the device under test');
}
if (!args.apk) throw new Error('--apk is required');
fs.mkdirSync(args.out, { recursive: true });
const only = new Set(args.only.split(',').filter(Boolean));

const NODE_NAME = 'AJ Companion';
const results = [];
const evidence = [];
const metrics = { latenciesMs: [], api: d.apiLevel() };
// Words that occur only in journal text, titles, or derived items. None may
// appear in the device log or the companion log (O08).
const MARKERS = ['kestrel', 'osprey', 'heron', 'plover', 'lapwing'];
let node;

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function step(id, title, work) {
  if (only.size && !only.has(id)) return;
  const started = performance.now();
  process.stdout.write(`${id} ${title} ... `);
  try {
    const detail = (await work()) ?? {};
    results.push({
      id,
      title,
      result: 'pass',
      ms: Math.round(performance.now() - started),
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
    evidence.push({ id, failure: d.snapshot() });
  }
}

function note(id, label) {
  evidence.push({ id, label, ui: d.snapshot() });
}

let instance = 0;
/** Stops the companion and keeps its whole log (counts only) as evidence. */
async function stopNode() {
  await node.stop();
  instance += 1;
  fs.writeFileSync(
    path.join(args.out, `companion-${instance}.log`),
    node.log.join(''),
  );
}

async function restart(options = {}) {
  const { stateDir, port } = node;
  await stopNode();
  node = await startCompanion({ name: NODE_NAME, stateDir, port, ...options });
}

async function jobs() {
  return (await node.stats()).jobs;
}

function jobLog() {
  return node.log
    .join('')
    .split('\n')
    .filter(line => line.includes('"job-ended"'))
    .map(line => JSON.parse(line));
}

/** Device cancellations (DELETE /v1/jobs/{id}) the companion received. */
function cancelRequests() {
  return node.log
    .join('')
    .split('\n')
    .filter(line => line.includes('"job-cancel-request"')).length;
}

/** One paragraph of distinct plain sentences, about `length` characters. */
function longParagraph(length, word) {
  const sentences = [];
  let total = 0;
  for (let i = 1; total < length; i += 1) {
    const sentence = `Entry ${word} line ${i} records an ordinary detail of the day.`;
    sentences.push(sentence);
    total += sentence.length + 1;
  }
  return sentences
    .join(' ')
    .slice(0, length)
    .replace(/\s+\S*$/, '.');
}

try {
  await step(
    'O00',
    'install, PIN, companion, pairing with compared codes',
    async () => {
      if (fs.existsSync(args.fixture)) d.adb('install', '-r', args.fixture);
      d.adb('install', '-r', args.apk);
      d.shell('pm', 'clear', d.PACKAGE);
      metrics.log = d.prepareDeviceLog();
      d.launch();
      await d.waitFor(
        { text: 'Create your private space' },
        { timeoutMs: 60_000 },
      );
      await setupPin();
      node = await startCompanion({ name: NODE_NAME });
      await pairWithNode(node);
      expect(
        (await node.pairings()).length === 1,
        'companion has no pairing record',
      );
      const status = await connectionLabel();
      expect(
        /Connected/.test(status),
        `not connected after pairing: ${status}`,
      );
      note('O00', 'paired');
      return { port: node.port };
    },
  );

  await step(
    'O01',
    'consent first; decline sends nothing; confirm stores a result',
    async () => {
      await writeEntry({
        title: 'Osprey morning',
        text: 'I need to send the kestrel budget to Priya by Friday.\n\nAfter work I want to call Mom about the birthday dinner.\n\nIdea: a weekend reading club for the neighbourhood.',
      });
      const before = await jobs();
      const declined = await organize({ consent: 'decline' });
      expect(
        declined.result === 'declined',
        `consent not shown: ${declined.result}`,
      );
      expect(
        declined.consentText.includes(NODE_NAME),
        'consent does not name the node',
      );
      expect(
        /Audio never leaves this phone/.test(declined.consentText),
        'consent does not say text only',
      );
      expect(
        (await jobs()) === before,
        'a request reached the node before consent',
      );
      const run = await organize();
      expect(run.result === 'stored', `outcome ${run.result}`);
      expect((await jobs()) === before + 1, 'not exactly one job');
      await d.findScrolling({ id: 'organize-summary' });
      await d.findScrolling({ id: 'organize-task-0' });
      metrics.latenciesMs.push(run.ms);
      note('O01', 'stored');
      await done();
      return { ms: run.ms };
    },
  );

  await step(
    'O02',
    'retry of an identical request is recognised and not sent',
    async () => {
      const before = await jobs();
      const run = await organize();
      expect(run.result === 'existing', `outcome ${run.result}`);
      expect((await jobs()) === before, 'an identical request was sent again');
      note('O02', 'existing');
      await done();
    },
  );

  await step('O03', 'cancel during a run stores nothing', async () => {
    // Four 10 s stages: a node-side cancel is distinguishable from the job
    // simply running to completion (40 s).
    await restart({ stageDelayMs: 10_000 });
    await writeEntry({
      text: 'Remember to book the heron dentist appointment.',
    });
    let cancelledAt;
    const jobsBefore = await jobs();
    const replaysBefore = (await node.stats()).replays;
    const cancelsBefore = cancelRequests();
    const run = await organize({
      onRunning: async () => {
        // Cancel once the node holds the job, so the node side is observable.
        const until = Date.now() + 20_000;
        while ((await jobs()) === jobsBefore && Date.now() < until) {
          await d.sleep(200);
        }
        await d.tap({ id: 'organize-cancel' });
        cancelledAt = Date.now();
      },
    });
    expect(run.result === 'cancelled', `outcome ${run.result}`);
    expect(
      !d.find(d.dump(), { id: 'organize-result' }),
      'a result is shown after cancel',
    );
    note('O03', 'cancelled');
    await done();
    // With SDK 0.1.0-m5 a cancel that arrives during a pending event read
    // never sends DELETE /v1/jobs/{id}, so the node runs the job to
    // completion (SDK-AJ-5). By default the node-side outcome is recorded;
    // --expect-node-cancel (a fixed SDK) asserts it. App-side, nothing is
    // stored either way.
    let ended;
    while (!ended && Date.now() - cancelledAt < 60_000) {
      ended = jobLog().find(j => j.state !== 'accepted');
      if (!ended) await d.sleep(500);
    }
    const detail = {
      nodeJobState: ended?.state ?? 'running',
      nodeJobEndedAfterCancelMs: Date.now() - cancelledAt,
      // The companion logs each device DELETE; a completed job would add a
      // replayable result.
      cancelRequests: cancelRequests() - cancelsBefore,
      replaysRetained: (await node.stats()).replays - replaysBefore,
      knownSdkDefect: ended?.state === 'cancelled' ? undefined : 'SDK-AJ-5',
    };
    if (!args['expect-node-cancel']) return detail;
    expect(
      detail.cancelRequests === 1,
      `the companion received ${detail.cancelRequests} cancellations, not 1`,
    );
    expect(
      ended?.state === 'cancelled' && detail.nodeJobEndedAfterCancelMs < 15_000,
      `the node job ended ${detail.nodeJobState}, not cancelled promptly`,
    );
    expect(
      detail.replaysRetained === 0,
      'the cancelled job left a retained result',
    );
    // The identical request again: the node must compute it afresh, with no
    // completed result surfacing from the cancelled job.
    const before = jobLog().length;
    const retry = await organize();
    expect(retry.result === 'stored', `retry outcome ${retry.result}`);
    const retried = jobLog().slice(before).at(-1);
    expect(
      retried?.state === 'completed' && typeof retried.engineMs === 'number',
      'the retry was not computed afresh',
    );
    await done();
    return { ...detail, retry: retried };
  });

  await step(
    'O04',
    'node down fails and stores nothing; node back stores and shows Connected',
    async () => {
      const { stateDir, port } = node;
      await stopNode();
      await writeEntry({
        text: 'We should plan the plover trip for December.',
      });
      const down = await organize();
      expect(
        down.result === 'failed',
        `outcome with the node down: ${down.result}`,
      );
      expect(
        !d.find(d.dump(), { id: 'organize-result' }),
        'a result is shown after failure',
      );
      note('O04', 'failed while down');
      await done();
      node = await startCompanion({ name: NODE_NAME, stateDir, port });
      let back;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        back = await organize();
        if (back.result === 'stored') break;
        await done();
        await d.sleep(3_000);
      }
      expect(
        back.result === 'stored',
        `outcome with the node back: ${back.result}`,
      );
      metrics.latenciesMs.push(back.ms);
      await done();
      const status = await connectionLabel();
      expect(
        /Connected/.test(status),
        `status after the node result: ${status}`,
      );
      note('O04', 'connected after recovery');
    },
  );

  await step(
    'O05',
    'deadline: a node too slow for 60 s stores nothing',
    async () => {
      await restart({ stageDelayMs: 20_000 });
      await writeEntry({ text: 'Make sure the lapwing report is filed.' });
      const run = await organize();
      expect(run.result === 'failed', `outcome ${run.result}`);
      expect(
        /did not finish in time|DEADLINE_EXCEEDED/.test(run.ui),
        `not a deadline failure: ${run.ui}`,
      );
      note('O05', 'deadline');
      await done();
      return { ms: run.ms };
    },
  );

  await step(
    'O06',
    'boundary: ~60 KB request, exact 61,440-byte completed message, over-cap refusal',
    async () => {
      await restart({ padResults: true });
      await writeEntry({ text: longParagraph(58_000, 'heron') });
      const before = jobLog().length;
      let run;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        run = await organize();
        if (run.result === 'stored') break;
        await done();
        await d.sleep(3_000);
      }
      expect(run.result === 'stored', `outcome ${run.result}`);
      const ended = jobLog()
        .slice(before)
        .filter(j => j.state === 'completed')
        .at(-1);
      expect(ended, 'no completed job in the companion log');
      // The completed message is {"data":{"output":…},"sequence":N,
      // "type":"completed"}: 51 bytes plus N's digits around the output.
      // The output is at the contract cap (61,387 bytes); with the test-only
      // padding the terminal sequence has two digits, so the message is the
      // contract's whole 61,440-byte budget (§8.1).
      const envelope = 51 + String(ended.sequence).length;
      const outputBytes = ended.lastMessageBytes - envelope;
      expect(
        outputBytes === 61_387 && ended.lastMessageBytes === 61_440,
        `completed message ${ended.lastMessageBytes} bytes (sequence ${ended.sequence}), output ${outputBytes}`,
      );
      note('O06', 'stored at the cap');
      await done();

      await writeEntry({ text: longParagraph(61_000, 'plover') });
      const jobsBefore = await jobs();
      const over = await organize();
      expect(over.result === 'refused', `over-cap outcome ${over.result}`);
      // The reason renders under the refusal; wait and scroll for it rather
      // than reading one snapshot (a slow device may not have drawn it yet).
      const reason = await d
        .findScrolling(
          { textMatches: /too long to send/ },
          { timeoutMs: 15_000 },
        )
        .catch(() => undefined);
      expect(reason, 'refusal does not say why');
      expect((await jobs()) === jobsBefore, 'an over-cap request was sent');
      note('O06', 'refused over the cap');
      await done();
      return {
        inputBytes: ended.inputBytes,
        completedMessageBytes: ended.lastMessageBytes,
        completedSequence: ended.sequence,
        ms: run.ms,
      };
    },
  );

  await step('O07', 'load: sequential organize runs', async () => {
    await restart();
    const runs = Number(args['load-runs']);
    const latencies = [];
    for (let i = 1; i <= runs; i += 1) {
      await writeEntry({
        text: `I need to email the kestrel team about item ${i}.\n\nRemember to water the plants ${i} times.`,
      });
      let run;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        run = await organize();
        if (run.result === 'stored') break;
        await done();
      }
      expect(run.result === 'stored', `run ${i}: ${run.result}`);
      latencies.push(run.ms);
      await done();
    }
    const sorted = [...latencies].sort((a, b) => a - b);
    metrics.latenciesMs.push(...latencies);
    return {
      runs,
      p50Ms: sorted[Math.floor((sorted.length - 1) / 2)],
      maxMs: sorted.at(-1),
    };
  });

  await step(
    'O08',
    'privacy: no journal text in either log; handshakes on the profile',
    async () => {
      const logFile = path.join(args.out, 'device.log');
      d.saveDeviceLog(logFile);
      const deviceLog = fs.readFileSync(logFile, 'utf8').toLowerCase();
      // Every companion instance of the run, the current one included.
      const companionLog = [
        ...fs
          .readdirSync(args.out)
          .filter(name => /^companion-\d+\.log$/.test(name))
          .map(name => fs.readFileSync(path.join(args.out, name), 'utf8')),
        node.log.join(''),
      ]
        .join('')
        .toLowerCase();
      for (const marker of MARKERS) {
        expect(!deviceLog.includes(marker), `device log contains "${marker}"`);
        expect(
          !companionLog.includes(marker),
          `companion log contains "${marker}"`,
        );
      }
      const events = new Set(
        companionLog
          .split('\n')
          .filter(line => line.startsWith('{'))
          .map(line => JSON.parse(line).event),
      );
      const handshakes = await node.handshakes();
      expect(handshakes.length > 0, 'no handshakes recorded');
      expect(
        handshakes.every(h => h.accepted),
        'a refused handshake from the app',
      );
      return {
        companionEvents: [...events].sort(),
        handshakes: [
          ...new Set(
            handshakes.map(h => `${h.protocol} ${h.cipher} ems=${h.ems}`),
          ),
        ],
      };
    },
  );
} finally {
  if (node?.log) await stopNode();
  const report = {
    apk: args.apk,
    api: metrics.api,
    serial: process.env.ANDROID_SERIAL,
    finishedAt: new Date().toISOString(),
    results,
    metrics,
  };
  fs.writeFileSync(
    path.join(args.out, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(args.out, 'evidence.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  const failed = results.filter(r => r.result === 'fail');
  process.stdout.write(
    `\n${results.length - failed.length}/${results.length} passed; report in ${
      args.out
    }\n`,
  );
  process.exitCode = failed.length ? 1 : 0;
}
