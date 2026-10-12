#!/usr/bin/env node
// AJ-3 Android device suite: the secure Private AI Node workflow driven through
// the real app UI, the packaged SDK, and the SDK repository's reference node.
//
//   node e2e/android/aj3-e2e.mjs --apk <app.apk> [--out <dir>] [--fixture <nsd.apk>]
//
// Requires a booted emulator (adb), Node.js 22, and the reference node at
// $HYBRID_AI_SDK_REPO (default ../hybridAi). Exits non-zero on any failure.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import * as d from './lib/device.mjs';
import { startNode } from './lib/node.mjs';

const { values: args } = parseArgs({
  options: {
    apk: { type: 'string' },
    fixture: {
      type: 'string',
      default: path.join(
        import.meta.dirname,
        'nsd-fixture/build/outputs/apk/debug/aj-nsd-fixture-debug.apk',
      ),
    },
    out: {
      type: 'string',
      default: fs.mkdtempSync(path.join(os.tmpdir(), 'aj3-e2e-')),
    },
    only: { type: 'string' },
    'no-install': { type: 'boolean', default: false },
    // Resume from <out>/checkpoint.json: same node identity and port, app data
    // kept, already-passed steps skipped.
    resume: { type: 'boolean', default: false },
    // AJ-1 builds: the vault persists the PIN, so a restart must ask to
    // unlock; being asked to create a PIN again is a failure.
    'expect-persistent-pin': { type: 'boolean', default: false },
    // With --resume: steps to run again even though they passed earlier.
    rerun: { type: 'string', default: '' },
  },
});
// One suite per device: never let adb pick a device implicitly.
if (!process.env.ANDROID_SERIAL) {
  throw new Error('ANDROID_SERIAL must name the device under test');
}
fs.mkdirSync(args.out, { recursive: true });

const PIN = '482915';
const results = [];
let node;

const checkpointFile = path.join(args.out, 'checkpoint.json');
const checkpoint =
  args.resume && fs.existsSync(checkpointFile)
    ? JSON.parse(fs.readFileSync(checkpointFile, 'utf8'))
    : undefined;
if (args.resume && !checkpoint) throw new Error(`no checkpoint in ${args.out}`);
const rerun = args.rerun.split(',').filter(Boolean);
const resumed = new Set(
  (checkpoint?.passed ?? []).filter(id => id !== 'S00' && !rerun.includes(id)),
);
const metrics = { ...(checkpoint?.metrics ?? {}) };
const state = { usedCode: checkpoint?.usedCode };
// Every attempt's step results and UI evidence are kept, so a resumed run
// still reports how and when each earlier step passed or failed.
const attempt = (checkpoint?.attempt ?? 0) + 1;
const history = [...(checkpoint?.history ?? [])];
const evidenceFile = path.join(args.out, 'evidence.json');
const evidence =
  checkpoint && fs.existsSync(evidenceFile)
    ? JSON.parse(fs.readFileSync(evidenceFile, 'utf8'))
    : [];

function saveCheckpoint() {
  // Keep steps carried by an earlier checkpoint even before they are re-listed.
  const failedNow = new Set(
    results.filter(r => r.result === 'fail').map(r => r.id),
  );
  const passed = [
    ...new Set([
      ...(checkpoint?.passed ?? []).filter(id => !failedNow.has(id)),
      ...results.filter(r => r.result === 'pass').map(r => r.id),
    ]),
  ].sort();
  fs.writeFileSync(
    checkpointFile,
    JSON.stringify(
      {
        savedAt: new Date().toISOString(),
        passed,
        node: node
          ? {
              stateDir: node.stateDir,
              port: node.port,
              nodeId: report.node?.nodeId,
            }
          : undefined,
        usedCode: state.usedCode,
        metrics,
        attempt,
        history,
        report: Object.fromEntries(
          Object.entries(report).filter(
            ([key]) => !['results', 'metrics', 'counts'].includes(key),
          ),
        ),
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
}

function note(label) {
  const text = d.snapshot();
  evidence.push({ attempt, step: current, label, text });
  return text;
}

let current = '';
async function step(id, title, body) {
  if (args.only && !args.only.split(',').includes(id)) return;
  if (resumed.has(id)) {
    const earlier = history.findLast(r => r.id === id && r.result === 'pass');
    results.push({ ...earlier, id, title, result: 'pass', resumed: true });
    process.stdout.write(`↷ ${id} ${title} (passed earlier; resumed)\n`);
    return;
  }
  current = `${id} ${title}`;
  const started = Date.now();
  process.stdout.write(`▶ ${current}\n`);
  try {
    await body();
    const passed = { id, title, result: 'pass', ms: Date.now() - started };
    results.push(passed);
    history.push({ ...passed, attempt });
    process.stdout.write(`  ✓ pass (${Date.now() - started} ms)\n`);
    saveCheckpoint();
  } catch (error) {
    const cause = error.cause
      ? ` (cause: ${error.cause.code ?? error.cause.message ?? error.cause})`
      : '';
    error.message = `${error.message}${cause}`;
    const failed = {
      id,
      title,
      result: 'fail',
      ms: Date.now() - started,
      error: String(error.message ?? error),
    };
    results.push(failed);
    history.push({ ...failed, attempt });
    process.stdout.write(`  ✗ FAIL ${error.message}\n`);
    try {
      note('failure state');
    } catch {
      // device unavailable
    }
    saveCheckpoint();
    // The step restored the state later steps need, so the suite goes on.
    if (error.continueSuite) return;
    throw error;
  }
}

/**
 * After the app has seen a node request fail, its status must stop claiming
 * "Connected" (UX 7.1). Returns the label shown, or undefined if it stayed.
 */
async function labelAfterFailure(timeoutMs = 30_000) {
  await openNodeScreen();
  return waitForConnection(/^(?!Connected$)./, timeoutMs).catch(
    () => undefined,
  );
}

/** After a request completes again, the status must return to "Connected". */
async function labelAfterRecovery(timeoutMs = 30_000) {
  await openNodeScreen();
  const label = await waitForConnection('Connected', timeoutMs).catch(
    () => undefined,
  );
  return label
    ? { connected: true, label }
    : { connected: false, label: await connectionLabel() };
}

/** A failure recorded after the step has restored the state later steps need. */
function failAndContinue(message) {
  return Object.assign(new Error(message), { continueSuite: true });
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function timing(key) {
  await openDiagnostics();
  const value = await d.readText(
    { id: `diag-timing-${key}` },
    { maxSwipes: 10 },
  );
  await d.scrollToTop();
  const ms = Number(/(\d+) ms/.exec(value ?? '')?.[1]);
  return Number.isFinite(ms) ? ms : undefined;
}

// --- Navigation helpers --------------------------------------------------------

async function unlockIfNeeded() {
  d.ensureForeground();
  const { selector } = await d.waitForAny([
    { id: 'unlock-pin' },
    { id: 'pin' },
    { text: 'Settings' },
  ]);
  if (selector.id === 'unlock-pin') {
    await typePin({ id: 'unlock-pin' });
    await d.hideKeyboard();
    await d.tap({ text: 'Unlock' });
    // AJ-1 derives the PIN key natively (Argon2id); allow it time.
    await d.waitFor({ text: 'Settings' }, { timeoutMs: 90_000 });
  } else if (selector.id === 'pin') {
    await setupPin();
  }
}

/** Types the PIN into a masked field; only its length can be checked. */
async function typePin(selector) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await d.clearField(selector);
    await d.typeInto(selector, PIN);
    if (d.textOf(selector)?.length === PIN.length) return;
  }
  throw new Error(`${d.describe(selector)} did not hold ${PIN.length} digits`);
}

async function setupPin() {
  await typePin({ id: 'pin' });
  await typePin({ id: 'pin-confirmation' });
  await d.hideKeyboard();
  await d.tap({ text: 'Protect my journal' });
  await d.waitFor({ text: 'Settings' }, { timeoutMs: 90_000 });
}

async function openSettingsHome() {
  await unlockIfNeeded();
  await d.tap({ text: 'Settings' });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (d.find(d.dump(), { id: 'open-private-node' })) return;
    // AJ-1's Settings scrolls; its first card may be above the viewport.
    await d.scrollToTop();
    if (d.find(d.dump(), { id: 'open-private-node' })) return;
    d.back();
    await d.sleep(500);
    await d.tap({ text: 'Settings' });
  }
  await d.waitFor({ id: 'open-private-node' });
}

async function openNodeScreen() {
  await openSettingsHome();
  await d.tap({ id: 'open-private-node' });
  await d.waitFor({ id: 'node-status-card' });
}

async function openDiagnostics() {
  if (d.find(d.dump(), { id: 'diag-timings' })) return;
  await openSettingsHome();
  await d.tap({ id: 'open-diagnostics' });
  // AJ-2 adds the Organize benchmark card above the request card, which can
  // put the request card below the fold: find it, then return to the top,
  // where the SDK state and policy rows are read without scrolling.
  await d.findScrolling({ id: 'diag-request-card' });
  await d.scrollToTop();
}

async function connectionLabel() {
  await d.scrollTo({ id: 'node-connection-state' });
  const pill = d.dump().find(n => n.id === 'node-connection-state');
  const nodes = d.dump();
  // The pill's label is the text node inside its bounds.
  const [x1, y1, x2, y2] = pill.bounds;
  return nodes.find(
    n =>
      n.text &&
      n.bounds &&
      n.bounds[0] >= x1 &&
      n.bounds[1] >= y1 &&
      n.bounds[2] <= x2 &&
      n.bounds[3] <= y2,
  )?.text;
}

async function waitForConnection(label, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await connectionLabel();
    if (label instanceof RegExp ? label.test(last ?? '') : last === label)
      return last;
    await d.sleep(700);
  }
  throw new Error(`connection label ${label} not reached; last "${last}"`);
}

async function enterCode(qr) {
  // Paste the full code through the fixture's clipboard helper; type it only
  // if pasting did not produce the exact code.
  const field = { id: 'pairing-code-input' };
  if (!(await d.pasteInto(field, qr))) {
    await d.clearField(field);
    await d.typeInto(field, qr);
  }
  d.shell('input', 'keyevent', 'KEYCODE_ENTER');
}

async function pairWithNode(
  target,
  { confirm = true, lifetimeSeconds = 300 } = {},
) {
  await openNodeScreen();
  const pairButton = d.find(d.dump(), { id: 'pair-node' })
    ? { id: 'pair-node' }
    : { text: 'Pair another node' };
  await d.tap(pairButton);
  await d.waitFor({ id: 'pairing-code-input' });
  const { qr } = await target.bootstrap(lifetimeSeconds);
  await enterCode(qr);
  await d.tap({ id: 'begin-pairing' });
  await d.waitFor({ id: 'verification-code' }, { timeoutMs: 30_000 });
  const appCode = d.textOf({ id: 'verification-code' });
  const pending = await target.pending();
  expect(pending, 'node has no pending pairing');
  expect(
    appCode === pending.verificationCode,
    `codes differ: app ${appCode} node ${pending.verificationCode}`,
  );
  note('verification code shown');
  if (!confirm) return { qr, appCode };
  await target.approve();
  await d.tap({ id: 'confirm-code' });
  await d.waitFor({ id: 'pairing-done' }, { timeoutMs: 30_000 });
  note('paired');
  await d.tap({ id: 'pairing-done' });
  return { qr, appCode };
}

async function runRequest({ target = 'auto', deadline = 30_000, input } = {}) {
  await openDiagnostics();
  await d.scrollToTop();
  if (input !== undefined) {
    // S19 checks that no input text reaches the device log.
    report.inputs = [...new Set([...(report.inputs ?? []), input])];
    await d.clearField({ id: 'diag-input' });
    // Type, don't paste: KEYCODE_PASTE in this multiline field also inserts
    // a stray 'V' before the clipboard text. Retry once if the text differs.
    await d.typeInto({ id: 'diag-input' }, input);
    if (d.textOf({ id: 'diag-input' }) !== input) {
      await d.clearField({ id: 'diag-input' });
      await d.typeInto({ id: 'diag-input' }, input);
    }
    expect(
      d.textOf({ id: 'diag-input' }) === input,
      `diagnostic input is ${JSON.stringify(d.textOf({ id: 'diag-input' }))}`,
    );
    await d.hideKeyboard();
    // Blur the field: a blinking cursor keeps uiautomator from idling.
    await d.tap({ text: 'INPUT' });
  }
  await d.tap({ id: `diag-target-${target}` });
  await d.tap({ id: `diag-deadline-${deadline}` });
  await d.tap({ id: 'diag-run' });
}

async function requestOutcome(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let phase;
  while (Date.now() < deadline) {
    phase = await d.readText({ id: 'diag-request-phase' }, { maxSwipes: 3 });
    if (/^(completed|failed|cancelled)$/.test(phase ?? '')) break;
    await d.sleep(500);
  }
  expect(
    /^(completed|failed|cancelled)$/.test(phase ?? ''),
    `request did not finish: ${phase}`,
  );
  const read = id => d.readText({ id }, { maxSwipes: 2 });
  const outcome = {
    phase,
    target: await read('diag-request-target'),
    reason: await read('diag-request-reason'),
    result: await read('diag-request-result'),
    nodeReason: await read('diag-request-node-reason'),
    code: /Code: (\w+)/.exec(d.snapshot())?.[1],
  };
  await d.scrollToTop();
  return outcome;
}

/**
 * Repeats a request until it ends in `phase` or the deadline passes. The SDK
 * marks an unreachable node `reachable=false` for routing, but `node.status()`
 * may keep its last state, so loss and recovery are proven by requests.
 */
async function requestUntil(phase, { target = 'node', input, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let outcome;
  do {
    await runRequest({ target, input });
    outcome = await requestOutcome();
    if (outcome.phase === phase) return outcome;
    await d.sleep(2_000);
  } while (Date.now() < deadline);
  return outcome;
}

/** Forgets every paired node through the UI, then pairs `node` again. */
async function forgetAllAndPair() {
  await openNodeScreen();
  for (let i = 0; i < 5; i += 1) {
    const row = await d
      .findScrolling({ id: 'forget-node' }, { timeoutMs: 5_000 })
      .catch(() => undefined);
    if (!row) break;
    await d.tap({ id: 'forget-node' });
    await d.sleep(3_000);
  }
  await d.findScrolling(
    { text: 'No nodes are paired with this device.' },
    { timeoutMs: 30_000 },
  );
  note('all nodes forgotten');
  await pairWithNode(node);
  await openNodeScreen();
  await waitForConnection('Connected');
}

// --- Suite ------------------------------------------------------------------------

const sha256 = file =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = {
  // Fields recorded by earlier attempts (codes, labels) are kept on resume.
  ...(checkpoint?.report ?? {}),
  startedAt: new Date().toISOString(),
  attempt,
  api: d.apiLevel(),
  apk: args.apk,
  // What ran where, so a report stands on its own.
  provenance: {
    command: process.argv.slice(1).join(' '),
    argv: process.argv.slice(1),
    serial: process.env.ANDROID_SERIAL,
    apkSha256:
      args.apk && fs.existsSync(args.apk) ? sha256(args.apk) : undefined,
    fixtureSha256: fs.existsSync(args.fixture)
      ? sha256(args.fixture)
      : undefined,
    avd: (() => {
      try {
        return d.adb('emu', 'avd', 'name').split(/\r?\n/)[0].trim();
      } catch {
        return undefined; // not an emulator
      }
    })(),
    fingerprint: d.shell('getprop', 'ro.build.fingerprint').trim(),
    node: process.version,
  },
};
// Every provenance field must be present before any step runs.
const missing = Object.entries(report.provenance)
  .filter(([key, value]) =>
    key === 'apkSha256'
      ? args.apk && !value
      : value === undefined || value === '',
  )
  .map(([key]) => key);
if (missing.length > 0) {
  throw new Error(`provenance incomplete: ${missing.join(', ')}`);
}

try {
  d.adb('install', '-r', args.fixture);
  // Never uninstall when resuming: the app's pairing must survive.
  if (!args['no-install'] && !checkpoint)
    d.adb('uninstall', d.PACKAGE).toString();
} catch {
  // not installed yet
}

try {
  await step('S00', 'clean install and reference node', async () => {
    if (checkpoint) {
      // Resume: same node identity and port; keep app data and pairing.
      d.stopAdvertising();
      d.quietKeyboard();
      node = await startNode({
        name: 'AJ Study Node',
        stateDir: checkpoint.node.stateDir,
        port: checkpoint.node.port,
      });
      report.node = { port: node.port, nodeId: await node.nodeId() };
      expect(
        report.node.nodeId === checkpoint.node.nodeId,
        'checkpoint node identity changed',
      );
      return;
    }
    if (!args['no-install']) {
      expect(args.apk && fs.existsSync(args.apk), '--apk is required');
      d.adb('install', '-r', args.apk);
    }
    d.forceStop();
    d.shell('pm', 'clear', d.PACKAGE);
    d.stopAdvertising();
    d.quietKeyboard();
    report.deviceLog = d.prepareDeviceLog();
    node = await startNode({ name: 'AJ Study Node' });
    report.node = { port: node.port, nodeId: await node.nodeId() };
  });

  await step('S01', 'cold launch opens the private lock shell', async () => {
    metrics.coldLaunchMs = d.launch();
    await d.waitFor({ text: 'Create your private space' });
    expect(
      !d.find(d.dump(), { text: 'Settings' }),
      'journal visible before PIN setup',
    );
    note('first launch');
  });

  await step(
    'S02',
    'PIN setup then SDK initialization with app policy',
    async () => {
      await setupPin();
      await openSettingsHome();
      await d.waitFor({
        id: 'settings-sdk-state',
        textMatches: /^Ready · \d+ capabilities$/,
      });
      expect(
        d.find(d.dump(), { text: 'Public package 0.1.0-m5' }),
        'package version missing',
      );
      note('settings');
      await openDiagnostics();
      expect(
        d.textOf({ id: 'diag-policy' }) === 'local on · node on',
        'policy not applied',
      );
      metrics.sdkInitMs = await timing('sdkInitMs');
      expect(metrics.sdkInitMs !== undefined, 'no SDK init timing');
    },
  );

  await step(
    'S03',
    'discovery: empty state, untrusted candidates, malformed hidden',
    async () => {
      await openNodeScreen();
      await d.tap({ id: 'start-discovery' });
      await d.sleep(4_000);
      note('discovery with no advertisers');
      await d.tap({ id: 'stop-discovery' });
      await d.waitFor({
        text: 'No nodes found nearby. You can still pair with a code.',
      });
      d.advertise([
        { name: 'AJ-Study-Node', nodeId: report.node.nodeId, port: node.port },
        {
          name: 'Kitchen-Node',
          nodeId: 'fedcba9876543210fedcba9876543210',
          port: 38996,
        },
        {
          name: 'Hostile-Node',
          nodeId: 'NOT-A-NODE-ID',
          port: 38999,
          txtvers: '2',
        },
      ]);
      d.launch();
      await unlockIfNeeded();
      await openNodeScreen();
      await d.tap({ id: 'start-discovery' });
      const started = Date.now();
      await d.waitFor({ text: '⁨Kitchen-Node⁩' }, { timeoutMs: 30_000 });
      await d.waitFor({ text: '⁨AJ-Study-Node⁩' }, { timeoutMs: 30_000 });
      metrics.discoveryObservedMs = Date.now() - started;
      await d.sleep(6_000);
      const text = note('discovery candidates');
      expect(
        !text.includes('Hostile-Node'),
        'malformed advertisement surfaced',
      );
      expect(!/Paired · Active/.test(text), 'candidate shown as paired');
      expect(
        d.count({ id: 'candidate-unpaired' }) === 2,
        'expected two unverified candidates',
      );
      await d.tap({ id: 'stop-discovery' });
      metrics.discoveryFirstMs = await timing('discoveryFirstMs');
      metrics.discoverySettledMs = await timing('discoverySettledMs');
      d.stopAdvertising();
    },
  );

  await step(
    'S04',
    'expired and invalid pairing codes are rejected',
    async () => {
      d.launch();
      await openNodeScreen();
      await d.tap({ id: 'pair-node' });
      const { qr } = await node.bootstrap(1);
      await d.sleep(1_500);
      await enterCode(qr);
      await d.waitFor({ id: 'pairing-code-expired' });
      expect(
        d.snapshot().includes('PAIRING_BOOTSTRAP_EXPIRED'),
        'expiry code not shown',
      );
      expect(
        !d.find(d.dump(), { id: 'begin-pairing' }),
        'expired code can still pair',
      );
      note('expired code');
      await d.tap({ text: 'Enter a new code' });
      await enterCode('hybrid-ai-pair:not-a-real-code');
      await d.waitFor({ id: 'pairing-failure' });
      expect(
        d.snapshot().includes('PAIRING_BOOTSTRAP_INVALID'),
        'invalid code not mapped',
      );
      note('invalid code');
      await d.tap({ text: 'Enter a new code' });
      d.back();
    },
  );

  await step(
    'S05',
    'mismatched verification code is declined by the user',
    async () => {
      await pairWithNode(node, { confirm: false });
      await d.tap({ id: 'reject-code' });
      await d.waitFor({ id: 'pairing-failure' }, { timeoutMs: 30_000 });
      const text = note('user declined');
      report.rejectCode = /Code: (\w+)/.exec(text)?.[1];
      expect(
        (await node.pairings()).length === 0,
        'node kept a pairing after rejection',
      );
      await d.tap({ text: 'Enter a new code' });
      d.back();
      await openNodeScreen();
      await d.waitFor({ text: 'No nodes are paired with this device.' });
    },
  );

  await step(
    'S06',
    'QR pairing with verification-code confirmation',
    async () => {
      const started = Date.now();
      // Long-lived so the replay below reaches the node instead of the expiry guard.
      ({ qr: state.usedCode } = await pairWithNode(node, {
        lifetimeSeconds: 300,
      }));
      metrics.pairingObservedMs = Date.now() - started;
      await openNodeScreen();
      await waitForConnection('Connected');
      expect(
        d.find(d.dump(), { text: 'Paired · Active' }),
        'paired node not active',
      );
      note('paired and connected');
      expect(
        (await node.pairings()).length === 1,
        'node has no pairing record',
      );
    },
  );

  await step('S07', 'a used pairing code cannot be replayed', async () => {
    await openNodeScreen();
    await d.tap({ text: 'Pair another node' });
    await enterCode(state.usedCode);
    const { selector } = await d.waitForAny([
      { id: 'begin-pairing' },
      { id: 'pairing-failure' },
    ]);
    if (selector.id === 'begin-pairing') await d.tap({ id: 'begin-pairing' });
    await d.waitFor({ id: 'pairing-failure' }, { timeoutMs: 30_000 });
    const text = note('replayed code');
    report.replayCode = /Code: (\w+)/.exec(text)?.[1];
    expect(
      (await node.pairings()).length === 1,
      'replay changed node pairings',
    );
    await d.tap({ text: 'Enter a new code' });
    d.back();
    metrics.pairingToCodeMs = await timing('pairingToCodeMs');
    metrics.confirmToPairedMs = await timing('confirmToPairedMs');
    metrics.firstReconnectMs = await timing('reconnectMs');
  });

  await step(
    'S08',
    'capability request: auto, explicit node, explicit local',
    async () => {
      await runRequest({ target: 'auto' });
      const auto = await requestOutcome();
      note('auto request');
      expect(
        auto.phase === 'completed' && auto.target === 'node',
        `auto: ${JSON.stringify(auto)}`,
      );
      expect(/^valid/.test(auto.result ?? ''), 'result not validated');
      report.autoReason = auto.reason;
      metrics.firstEventMs = await timing('firstEventMs');
      metrics.firstResponseMs = await timing('firstResponseMs');
      await runRequest({ target: 'node' });
      const explicitNode = await requestOutcome();
      expect(
        explicitNode.target === 'node' &&
          explicitNode.reason === 'explicit_node',
        `node: ${JSON.stringify(explicitNode)}`,
      );
      await runRequest({ target: 'local' });
      const local = await requestOutcome();
      note('explicit local request');
      // Explicit targets never switch: document.analyze is node-only.
      expect(
        local.phase === 'failed' && local.target === undefined,
        `local: ${JSON.stringify(local)}`,
      );
      report.explicitLocalCode = local.code;
      // The developer's own input field holds the text; nothing else may show it.
      const leaked = d
        .dump()
        .filter(
          n => n.id !== 'diag-input' && n.text.includes('Plan the garden'),
        );
      expect(leaked.length === 0, 'diagnostics leaked input text');
    },
  );

  await step('S09', 'cancellation and deadline', async () => {
    await runRequest({ target: 'node', input: '__fixture_hold__' });
    await d.waitFor({ id: 'diag-cancel' });
    const started = Date.now();
    await d.tap({ id: 'diag-cancel' });
    const cancelled = await requestOutcome();
    metrics.cancelObservedMs = Date.now() - started;
    expect(
      cancelled.phase === 'cancelled',
      `cancel: ${JSON.stringify(cancelled)}`,
    );
    note('cancelled');
    // Re-enter the hold input: navigation can re-mount Diagnostics and reset it.
    await runRequest({
      target: 'node',
      deadline: 5_000,
      input: '__fixture_hold__',
    });
    const expired = await requestOutcome(30_000);
    note('deadline');
    expect(
      expired.phase === 'failed' && expired.code === 'DEADLINE_EXCEEDED',
      `deadline: ${JSON.stringify(expired)}`,
    );
    await d.tap({ id: 'diag-deadline-30000' });
  });

  await step('S10', 'policy restricts routing (node disabled)', async () => {
    await openNodeScreen();
    await d.tap({ id: 'policy-allow-node' });
    await d.waitFor({ text: 'Use Private AI Node: Off' });
    await runRequest({
      target: 'auto',
      input: 'Policy check text for routing.',
    });
    const denied = await requestOutcome();
    note('policy denied');
    expect(denied.phase === 'failed', `policy: ${JSON.stringify(denied)}`);
    report.policyDenied = { code: denied.code, nodeReason: denied.nodeReason };
    await openNodeScreen();
    await d.tap({ id: 'policy-allow-node' });
    await d.waitFor({ text: 'Use Private AI Node: On' });
  });

  await step(
    'S11',
    'spoofed candidate claiming the paired identity',
    async () => {
      d.advertise([
        { name: 'AJ-Study-Node', nodeId: report.node.nodeId, port: node.port },
        { name: 'AJ-Study-Node', nodeId: report.node.nodeId, port: 38998 },
        {
          name: 'AJ-Study-Node-2',
          nodeId: '0123456789abcdef0123456789abcdef',
          port: 38997,
        },
      ]);
      d.launch();
      await unlockIfNeeded();
      await openNodeScreen();
      await d.tap({ id: 'start-discovery' });
      // With a node paired, "Nearby nodes" sits below the fold: scroll to it.
      await d.findScrolling(
        { text: '⁨AJ-Study-Node-2⁩' },
        { timeoutMs: 45_000 },
      );
      await d.sleep(5_000);
      await d.findScrolling(
        { text: 'Unverified · Possible impersonation' },
        { timeoutMs: 15_000 },
      );
      const text = note('spoof candidates');
      const flagged =
        d.count({ id: 'candidate-claims_paired_identity' }) +
        d.count({ id: 'candidate-conflicting_identity' }) +
        d.count({ id: 'candidate-lookalike_name' });
      expect(flagged >= 1, 'no candidate flagged');
      expect(
        text.includes('Possible impersonation'),
        'impersonation not identified',
      );
      await d.tap({ id: 'stop-discovery' });
      // Trust is unchanged and a secure reconnect still lands on the real node.
      await d.tap({ id: 'node-status-card' }).catch(() => {});
      await waitForConnection('Connected');
      d.stopAdvertising();
    },
  );

  await step('S12', 'network loss and recovery', async () => {
    const problems = [];
    // AVDs created with avdmanager also have eth0, which keeps the default
    // network alive when Wi-Fi and data are off. On test devices, take it down
    // too (needs root; restarting adbd drops reverse rules, so re-add them).
    const ethernet = /^eth0\s+UP/m.test(d.shell('ip', '-brief', 'link'));
    if (ethernet) {
      d.adb('root');
      d.adb('wait-for-device');
      await d.sleep(2_000);
      d.adb('reverse', `tcp:${node.port}`, `tcp:${node.port}`);
    }
    report.networkCut = `${
      ethernet ? 'wifi+data+eth0' : 'wifi+data'
    } + adb-reverse path + live sockets`;
    d.launch();
    await openNodeScreen();
    d.shell('svc', 'wifi', 'disable');
    d.shell('svc', 'data', 'disable');
    if (ethernet) d.shell('ip', 'link', 'set', 'eth0', 'down');
    // The node is reached over `adb reverse` (127.0.0.1), which device networks
    // do not affect. Cut that path and the live sockets too, so the loss is
    // real for the app (a simulated path loss, not a physical radio cut).
    d.adb('reverse', '--remove', `tcp:${node.port}`);
    await node.dropConnections();
    try {
      const lost = await requestUntil('failed', {
        target: 'node',
        input: 'Network loss probe entry.',
        timeoutMs: 60_000,
      });
      expect(
        lost.phase === 'failed',
        `request succeeded with the path cut: ${JSON.stringify(lost)}`,
      );
      const label = await labelAfterFailure();
      report.networkLoss = {
        code: lost.code,
        nodeReason: lost.nodeReason,
        statusLabel: label ?? (await connectionLabel()),
      };
      note('network lost');
      if (!label)
        problems.push(
          `status stayed "${report.networkLoss.statusLabel}" after a request failed with ${lost.code}`,
        );
    } finally {
      if (ethernet) d.shell('ip', 'link', 'set', 'eth0', 'up');
      d.shell('svc', 'wifi', 'enable');
      d.shell('svc', 'data', 'enable');
      d.adb('reverse', `tcp:${node.port}`, `tcp:${node.port}`);
    }
    const started = Date.now();
    const recovered = await requestUntil('completed', {
      target: 'node',
      input: 'Recovered network check entry.',
      timeoutMs: 120_000,
    });
    metrics.networkRecoveryObservedMs = Date.now() - started;
    expect(
      recovered.phase === 'completed',
      `no recovery: ${JSON.stringify(recovered)}`,
    );
    note('network recovered');
    // A request completed again, so the status must not stay on a failure.
    const recoveredLabel = await labelAfterRecovery();
    report.networkRecoveredLabel = recoveredLabel.label;
    if (!recoveredLabel.connected)
      problems.push(
        `status "${recoveredLabel.label}" after a request completed again`,
      );
    if (problems.length > 0) throw failAndContinue(problems.join('; '));
  });

  await step('S13', 'node interruption and secure reconnect', async () => {
    const { port, stateDir } = node;
    await node.stop();
    const down = await requestUntil('failed', {
      target: 'auto',
      input: 'Node down probe entry.',
      timeoutMs: 60_000,
    });
    expect(down.phase === 'failed', 'request succeeded with node down');
    report.nodeDownRequest = { code: down.code, nodeReason: down.nodeReason };
    const downLabel = await labelAfterFailure();
    report.nodeDownLabel = downLabel ?? (await connectionLabel());
    note('node down');
    const problems = downLabel
      ? []
      : [
          `status stayed "${report.nodeDownLabel}" after a request failed with ${down.code}`,
        ];
    await openSettingsHome();
    await d.tap({ text: 'Diary' });
    // AJ-0 shows a placeholder; AJ-1 shows the real journal (empty state or
    // Write action). Either proves the journal stays usable without a node.
    const journal = await d.waitForAny([
      {
        text: 'Your private voice and written entries, in their original order.',
      },
      { id: 'diary-write' },
      { text: 'What do you want to remember?' },
    ]);
    report.journalScreen = journal.selector.id ?? journal.selector.text;
    note('journal usable without node');
    node = await startNode({ name: 'AJ Study Node', stateDir, port });
    // No Reconnect tap: a node request must complete on its own once the
    // node is back, and that result alone must bring the status back to
    // Connected (UX §7.1).
    const back = await requestUntil('completed', {
      target: 'node',
      input: 'Node restarted check entry.',
      timeoutMs: 120_000,
    });
    expect(
      back.phase === 'completed',
      `no node result without a tap: ${JSON.stringify(back)}`,
    );
    report.nodeBackWithoutTap = true;
    note('node result after restart, no tap');
    const backLabel = await labelAfterRecovery();
    report.nodeBackLabel = backLabel.label;
    if (!backLabel.connected)
      problems.push(
        `status "${backLabel.label}" after a request completed again`,
      );
    if (problems.length > 0) throw failAndContinue(problems.join('; '));
  });

  await step(
    'S14',
    'background/foreground relock and cancellation of attended flows',
    async () => {
      await openNodeScreen();
      await d.tap({ text: 'Pair another node' });
      const { qr } = await node.bootstrap(120);
      await enterCode(qr);
      await d.waitFor({ id: 'begin-pairing' });
      d.home();
      await d.sleep(1_500);
      d.launch();
      await d.waitFor({ id: 'unlock-pin' });
      expect(
        !d.snapshot().includes('Pair with this node?'),
        'pairing visible while locked',
      );
      note('relocked after background');
      await unlockIfNeeded();
      await openNodeScreen();
      await waitForConnection('Connected');
      expect((await node.pairings()).length === 1, 'background pairing leaked');
    },
  );

  await step(
    'S15',
    'process restart reconnects to the paired node',
    async () => {
      d.forceStop();
      metrics.restartLaunchMs = d.launch();
      if (args['expect-persistent-pin']) {
        const { selector } = await d.waitForAny(
          [{ id: 'unlock-pin' }, { id: 'pin' }],
          {
            timeoutMs: 30_000,
          },
        );
        expect(
          selector.id === 'unlock-pin',
          'restart asked to create a PIN: the persistent PIN was lost',
        );
      }
      // AJ-0's verifier is volatile, so there a restart re-creates the PIN.
      await unlockIfNeeded();
      await openNodeScreen();
      await waitForConnection('Connected', 45_000);
      note('restart reconnect');
      metrics.restartReconnectMs = await timing('reconnectMs');
    },
  );

  await step('S16', 'forget and re-pair', async () => {
    await openNodeScreen();
    // Resumable: an interrupted earlier attempt may already have forgotten it.
    const forget = await d
      .findScrolling({ id: 'forget-node' }, { timeoutMs: 10_000 })
      .catch(() => undefined);
    if (forget) {
      await d.tap({ id: 'forget-node' });
    } else {
      report.forgetDoneInEarlierAttempt = true;
    }
    await d.findScrolling(
      { text: 'No nodes are paired with this device.' },
      { timeoutMs: 30_000 },
    );
    const text = note('forgotten');
    report.forgetConfirmed = text.includes(
      'The node confirmed it removed this device.',
    );
    expect(
      (await node.pairings()).length === 0,
      'node still lists the pairing',
    );
    await runRequest({ target: 'auto', input: 'After forget check entry.' });
    const unpaired = await requestOutcome();
    expect(unpaired.phase === 'failed', 'request succeeded without a pairing');
    report.unpairedRequest = {
      code: unpaired.code,
      nodeReason: unpaired.nodeReason,
    };
    await pairWithNode(node);
    await openNodeScreen();
    await waitForConnection('Connected');
    note('re-paired');
  });

  await step(
    'S17',
    'revoked trust is shown and recovered by re-pairing',
    async () => {
      await openNodeScreen();
      const start = await connectionLabel();
      if (start !== 'Connected') {
        // Resumable: an interrupted attempt may have left a revoked record.
        report.revokedStepStartedFrom = start;
        await forgetAllAndPair();
      }
      await node.revokeAll();
      // The node closes this device's sockets, but the SDK's status changes
      // only on its next contact with the node (as in S12). Record what the
      // app shows before that, then make contact with a request.
      await openNodeScreen();
      await d.sleep(10_000);
      report.revokedLabelBeforeContact = await connectionLabel();
      const refused = await requestUntil('failed', {
        target: 'node',
        input: 'Revoked trust probe entry.',
        timeoutMs: 60_000,
      });
      expect(
        refused.phase === 'failed' && refused.code === 'NODE_TRUST_REVOKED',
        `after revocation: ${JSON.stringify(refused)}`,
      );
      report.revokedRequest = {
        code: refused.code,
        nodeReason: refused.nodeReason,
      };
      // The app now knows trust is revoked; its status must say "Trust
      // revoked" and offer "Forget and pair again" (UX 7.1).
      const problems = [];
      await openNodeScreen();
      let shown = await waitForConnection('Trust revoked', 30_000).catch(
        () => undefined,
      );
      report.revokedLabelAfterRefusal = shown ?? (await connectionLabel());
      note('after the refused request');
      if (!shown) {
        problems.push(
          `status "${report.revokedLabelAfterRefusal}" after the refused request`,
        );
        // A restart's connect makes the SDK re-check trust.
        d.forceStop();
        d.launch();
        await unlockIfNeeded();
        await openNodeScreen();
        shown = await waitForConnection('Trust revoked', 45_000).catch(
          () => undefined,
        );
        report.revokedLabelAfterRestart = shown ?? (await connectionLabel());
        note('after a restart');
        if (!shown)
          problems.push(
            `status "${report.revokedLabelAfterRestart}" after a restart`,
          );
      }
      // Recover with the specified action, or else the paired row's Forget,
      // so that later steps start from a paired, connected node.
      if (d.find(d.dump(), { id: 'forget-and-repair' })) {
        await d.tap({ id: 'forget-and-repair' });
        await d.waitFor({ id: 'pairing-code-input' }, { timeoutMs: 30_000 });
        d.back();
        await pairWithNode(node);
        await openNodeScreen();
        await waitForConnection('Connected');
      } else {
        problems.push('no "Forget and pair again" action');
        await forgetAllAndPair();
      }
      note('re-paired after revocation');
      report.revokedProblems = problems;
      if (problems.length > 0)
        throw failAndContinue(
          `revoked trust not shown as specified: ${problems.join('; ')}`,
        );
    },
  );

  await step(
    'S18',
    'wrong node identity on the paired endpoint is refused',
    async () => {
      const { port, stateDir } = node;
      await node.stop();
      const impostor = await startNode({ name: 'AJ Study Node', port });
      try {
        d.forceStop();
        d.launch();
        await unlockIfNeeded();
        await openNodeScreen();
        const label = await waitForConnection(
          /Identity check failed|Unavailable|Reconnecting…|Not connected/,
          45_000,
        );
        report.wrongIdentityLabel = label;
        const text = note('wrong identity');
        expect(!/Connected$/.test(label), 'connected to impostor');
        expect(!text.includes('| Connected |'), 'impostor shown as connected');
        expect(
          (await impostor.pairings()).length === 0,
          'impostor obtained a pairing',
        );
      } finally {
        await impostor.stop();
      }
      node = await startNode({ name: 'AJ Study Node', stateDir, port });
      await openNodeScreen();
      const reconnect = d.find(d.dump(), { id: 'reconnect' });
      if (reconnect) await d.tap({ id: 'reconnect' });
      await waitForConnection('Connected', 60_000);
    },
  );

  await step(
    'S19',
    'privacy: no secrets or input text in device logs',
    async () => {
      const logFile = path.join(args.out, 'logcat.txt');
      d.saveDeviceLog(logFile);
      const log = fs.readFileSync(logFile, 'utf8');
      report.logScan = {
        bytes: log.length,
        firstLineAt: Number(/^\s*(\d+\.\d+)\s/m.exec(log)?.[1]),
        // 'run': cleared at S00 on this boot; 'buffer': whatever it still held.
        coverage: report.deviceLog ? 'run' : 'buffer',
      };
      if (report.deviceLog) {
        expect(
          d.bootId() === report.deviceLog.bootId,
          'device rebooted during the run: earlier logs are gone',
        );
        const full = d.nearlyFullLogBuffers();
        expect(
          full.length === 0,
          `log buffers nearly full (${full.join(
            ', ',
          )}): earlier steps may be pruned`,
        );
      }
      // Every request input this suite types, including steps that passed in
      // earlier attempts, plus anything recorded by this run.
      const inputs = new Set([
        'Plan the garden',
        '__fixture_hold__',
        'Policy check text for routing.',
        'Network loss probe entry.',
        'Recovered network check entry.',
        'Node down probe entry.',
        'Node restarted check entry.',
        'After forget check entry.',
        'Revoked trust probe entry.',
        ...(report.inputs ?? []),
      ]);
      const forbidden = [
        ['pairing code', 'hybrid-ai-pair:'],
        ...[...inputs].map((input, i) => [`input #${i + 1}`, input]),
      ];
      if (state.usedCode) {
        const payload = state.usedCode.slice('hybrid-ai-pair:'.length);
        forbidden.push(['pairing payload', payload]);
        try {
          const { secret } = JSON.parse(
            Buffer.from(payload, 'base64url').toString(),
          );
          if (secret) forbidden.push(['pairing secret', secret]);
        } catch {
          // payload format changed; the prefix and payload checks remain
        }
      }
      // Labels, not values, in failure messages: never echo a secret.
      for (const [label, value] of forbidden)
        expect(!log.includes(value), `device log contains the ${label}`);
      // A 6-digit PIN is checked as a whole number, not inside longer ones.
      expect(
        !new RegExp(`(?<![0-9])${PIN}(?![0-9])`).test(log),
        'device log contains the PIN',
      );
      report.logScan.checked = forbidden.length + 1;
    },
  );
} catch {
  // recorded in results
} finally {
  d.shell('svc', 'wifi', 'enable');
  d.shell('svc', 'data', 'enable');
  try {
    d.shell('ip', 'link', 'set', 'eth0', 'up');
  } catch {
    // not root or no eth0
  }
  try {
    d.stopAdvertising();
  } catch {
    // fixture missing
  }
  if (node) {
    fs.writeFileSync(path.join(args.out, 'node.log'), node.log.join(''));
    await node.stop();
  }
  report.finishedAt = new Date().toISOString();
  report.results = results;
  report.history = history;
  report.metrics = metrics;
  report.counts = {
    pass: results.filter(r => r.result === 'pass').length,
    fail: results.filter(r => r.result === 'fail').length,
  };
  fs.writeFileSync(
    path.join(args.out, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
  console.log(
    JSON.stringify({ out: args.out, counts: report.counts, metrics }, null, 2),
  );
  process.exitCode = report.counts.fail === 0 && results.length > 0 ? 0 : 1;
}
