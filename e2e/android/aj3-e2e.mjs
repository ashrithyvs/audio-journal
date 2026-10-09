#!/usr/bin/env node
// AJ-3 Android device suite: the secure Private AI Node workflow driven through
// the real app UI, the packaged SDK, and the SDK repository's reference node.
//
//   node e2e/android/aj3-e2e.mjs --apk <app.apk> [--out <dir>] [--fixture <nsd.apk>]
//
// Requires a booted emulator (adb), Node.js 22, and the reference node at
// $HYBRID_AI_SDK_REPO (default ../hybridAi). Exits non-zero on any failure.
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
  },
});
fs.mkdirSync(args.out, { recursive: true });

const PIN = '482915';
const results = [];
const metrics = {};
const evidence = [];
let node;

function note(label) {
  const text = d.snapshot();
  evidence.push({ step: current, label, text });
  return text;
}

let current = '';
async function step(id, title, body) {
  if (args.only && !args.only.split(',').includes(id)) return;
  current = `${id} ${title}`;
  const started = Date.now();
  process.stdout.write(`▶ ${current}\n`);
  try {
    await body();
    results.push({ id, title, result: 'pass', ms: Date.now() - started });
    process.stdout.write(`  ✓ pass (${Date.now() - started} ms)\n`);
  } catch (error) {
    const cause = error.cause
      ? ` (cause: ${error.cause.code ?? error.cause.message ?? error.cause})`
      : '';
    error.message = `${error.message}${cause}`;
    results.push({
      id,
      title,
      result: 'fail',
      ms: Date.now() - started,
      error: String(error.message ?? error),
    });
    process.stdout.write(`  ✗ FAIL ${error.message}\n`);
    try {
      note('failure state');
    } catch {
      // device unavailable
    }
    throw error;
  }
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
    await d.typeInto({ id: 'unlock-pin' }, PIN);
    await d.hideKeyboard();
    await d.tap({ text: 'Unlock' });
    await d.waitFor({ text: 'Settings' });
  } else if (selector.id === 'pin') {
    await setupPin();
  }
}

async function setupPin() {
  await d.typeInto({ id: 'pin' }, PIN);
  await d.typeInto({ id: 'pin-confirmation' }, PIN);
  await d.hideKeyboard();
  await d.tap({ text: 'Protect my journal' });
  await d.waitFor({ text: 'Settings' });
}

async function openSettingsHome() {
  await unlockIfNeeded();
  await d.tap({ text: 'Settings' });
  for (let attempt = 0; attempt < 4; attempt += 1) {
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
  await d.waitFor({ id: 'diag-request-card' });
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
  await d.typeInto({ id: 'pairing-code-input' }, qr);
  d.shell('input', 'keyevent', 'KEYCODE_ENTER');
}

async function pairWithNode(
  target,
  { confirm = true, lifetimeSeconds = 120 } = {},
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
    await d.clearField({ id: 'diag-input' });
    await d.typeInto({ id: 'diag-input' }, input);
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

// --- Suite ------------------------------------------------------------------------

const report = {
  startedAt: new Date().toISOString(),
  api: d.apiLevel(),
  apk: args.apk,
};
try {
  if (!args['no-install']) {
    d.adb('install', '-r', args.fixture);
    d.adb('uninstall', d.PACKAGE).toString();
  }
} catch {
  // not installed yet
}

try {
  await step('S00', 'clean install and reference node', async () => {
    if (!args['no-install']) {
      expect(args.apk && fs.existsSync(args.apk), '--apk is required');
      d.adb('install', '-r', args.apk);
    }
    d.forceStop();
    d.shell('pm', 'clear', d.PACKAGE);
    d.stopAdvertising();
    d.quietKeyboard();
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

  let usedCode;
  await step(
    'S06',
    'QR pairing with verification-code confirmation',
    async () => {
      const started = Date.now();
      // Long-lived so the replay below reaches the node instead of the expiry guard.
      ({ qr: usedCode } = await pairWithNode(node, { lifetimeSeconds: 300 }));
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
    await enterCode(usedCode);
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
    await runRequest({ target: 'node', deadline: 5_000 });
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
      await d.waitFor({ text: '⁨AJ-Study-Node-2⁩' }, { timeoutMs: 30_000 });
      await d.sleep(5_000);
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
    d.launch();
    await openNodeScreen();
    d.shell('svc', 'wifi', 'disable');
    d.shell('svc', 'data', 'disable');
    try {
      const lost = await waitForConnection(
        /Reconnecting…|Unavailable|Not connected/,
        45_000,
      );
      report.networkLossLabel = lost;
      note('network lost');
    } finally {
      d.shell('svc', 'wifi', 'enable');
      d.shell('svc', 'data', 'enable');
    }
    const started = Date.now();
    await waitForConnection('Connected', 90_000);
    metrics.networkRecoveryObservedMs = Date.now() - started;
    note('network recovered');
    await runRequest({
      target: 'node',
      input: 'Recovered network check entry.',
    });
    const after = await requestOutcome();
    expect(
      after.phase === 'completed',
      `post-recovery request: ${JSON.stringify(after)}`,
    );
  });

  await step('S13', 'node interruption and secure reconnect', async () => {
    const { port, stateDir } = node;
    await node.stop();
    await openNodeScreen();
    const down = await waitForConnection(
      /Reconnecting…|Unavailable|Not connected/,
      45_000,
    );
    report.nodeDownLabel = down;
    note('node down');
    await runRequest({ target: 'auto' });
    const unavailable = await requestOutcome();
    expect(unavailable.phase === 'failed', 'request succeeded with node down');
    report.nodeDownRequest = {
      code: unavailable.code,
      nodeReason: unavailable.nodeReason,
    };
    await openSettingsHome();
    await d.tap({ text: 'Diary' });
    await d.waitFor({
      text: 'Your private voice and written entries, in their original order.',
    });
    note('journal usable without node');
    node = await startNode({ name: 'AJ Study Node', stateDir, port });
    await openNodeScreen();
    const reconnect = d.find(d.dump(), { id: 'reconnect' });
    if (reconnect) await d.tap({ id: 'reconnect' });
    await waitForConnection('Connected', 60_000);
    note('reconnected after node restart');
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
      // The AJ-0 lock verifier is volatile, so a restart re-creates the PIN.
      await unlockIfNeeded();
      await openNodeScreen();
      await waitForConnection('Connected', 45_000);
      note('restart reconnect');
      metrics.restartReconnectMs = await timing('reconnectMs');
    },
  );

  await step('S16', 'forget and re-pair', async () => {
    await openNodeScreen();
    await d.tap({ id: 'forget-node' });
    await d.waitFor(
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
      await node.revokeAll();
      await openNodeScreen();
      const reconnect = d.find(d.dump(), { id: 'reconnect' });
      if (reconnect) await d.tap({ id: 'reconnect' });
      const label = await waitForConnection(
        /Trust revoked|Identity check failed|Unavailable|Reconnecting…|Not connected/,
        60_000,
      );
      report.revokedLabel = label;
      let text = note('revoked');
      if (!/Trust revoked/.test(text)) {
        await d.tap({ id: 'reconnect' }).catch(() => {});
        await waitForConnection('Trust revoked', 45_000);
        text = note('revoked after reconnect');
      }
      expect(
        d.find(d.dump(), { id: 'forget-and-repair' }),
        'no forget-and-repair action',
      );
      await d.tap({ id: 'forget-and-repair' });
      await d.waitFor({ id: 'pairing-code-input' }, { timeoutMs: 30_000 });
      d.back();
      await pairWithNode(node);
      await openNodeScreen();
      await waitForConnection('Connected');
      note('re-paired after revocation');
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
      const log = d.adb('logcat', '-d');
      fs.writeFileSync(path.join(args.out, 'logcat.txt'), log);
      const forbidden = [
        PIN,
        'hybrid-ai-pair:',
        'Plan the garden',
        'Policy check text',
        'Recovered network check',
      ];
      for (const value of forbidden)
        expect(!log.includes(value), `logcat contains "${value}"`);
    },
  );
} catch {
  // recorded in results
} finally {
  d.shell('svc', 'wifi', 'enable');
  d.shell('svc', 'data', 'enable');
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
  report.metrics = metrics;
  report.counts = {
    pass: results.filter(r => r.result === 'pass').length,
    fail: results.filter(r => r.result === 'fail').length,
  };
  fs.writeFileSync(
    path.join(args.out, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  fs.writeFileSync(
    path.join(args.out, 'evidence.json'),
    JSON.stringify(evidence, null, 2),
  );
  console.log(
    JSON.stringify({ out: args.out, counts: report.counts, metrics }, null, 2),
  );
  process.exitCode = report.counts.fail === 0 && results.length > 0 ? 0 : 1;
}
