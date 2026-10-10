// AJ-1 targeted device check for AJ-3 report F3 (UX §7.1): the Private AI
// Node screen offers one recovery action, and Reconnect only where it
// applies. It drives the SDK repository's reference node through the shared
// AJ-3 helpers (read-only) and records, for each state, the status label, the
// number of Reconnect and "Forget and pair again" actions, and whether a
// failure notice is shown:
// - Connected after pairing: no Reconnect, no notice;
// - node stopped, a node request fails, then a tapped Reconnect fails:
//   Unavailable with exactly one Reconnect and the notice;
// - node restarted and a node request completes, with no tap: Connected with
//   no Reconnect and no stale notice (the case F3 left open before 78a9295).
// Revoked trust ("Forget and pair again", no Reconnect) is S17 of the AJ-3
// suite. Evidence is UI-hierarchy text, because FLAG_SECURE blocks
// screenshots.
//
//   ANDROID_SERIAL=emulator-5554 node e2e/aj1/node-f3.mjs <apk> [--out <dir>]

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { pairWithNode, openSettingsHome } from '../android/lib/app.mjs';
import * as d from '../android/lib/device.mjs';
import { startNode } from '../android/lib/node.mjs';

const apk = process.argv[2];
const at = process.argv.indexOf('--out');
const out = at > 0 ? process.argv[at + 1] : 'aj1-node-f3';
fs.mkdirSync(out, { recursive: true });
const results = [];
const evidence = [];
let node;

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

async function openNodeScreen() {
  await openSettingsHome();
  await d.tap({ id: 'open-private-node' });
  await d.waitFor({ id: 'node-status-card' });
  await d.scrollToTop();
}

/** The status label and the actions visible on the node screen. */
function actions(label) {
  const nodes = d.dump();
  const pill = nodes.find(n => n.id === 'node-connection-state');
  const inside = pill?.bounds
    ? nodes.find(
        n =>
          n.text &&
          n.bounds &&
          n.bounds[0] >= pill.bounds[0] &&
          n.bounds[1] >= pill.bounds[1] &&
          n.bounds[2] <= pill.bounds[2] &&
          n.bounds[3] <= pill.bounds[3],
      )
    : undefined;
  const shown = {
    status: inside?.text,
    reconnect: nodes.filter(n => n.text === 'Reconnect').length,
    forgetAndPairAgain: nodes.filter(n => n.text === 'Forget and pair again')
      .length,
    notice: nodes.some(n => n.id === 'link-failure'),
  };
  evidence.push({
    label,
    ...shown,
    text: nodes
      .map(n => n.text)
      .filter(Boolean)
      .join(' | '),
  });
  return shown;
}

async function waitForStatus(label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let shown;
  while (Date.now() < deadline) {
    await openNodeScreen();
    shown = actions(`waiting for ${label}`);
    evidence.pop();
    if (shown.status === label) return;
    await d.sleep(1_500);
  }
  throw new Error(`status ${label} not reached; last "${shown?.status}"`);
}

/** One node request from Developer diagnostics; returns its final phase. */
async function nodeRequest() {
  await openSettingsHome();
  await d.tap({ id: 'open-diagnostics' });
  await d.waitFor({ id: 'diag-request-card' });
  await d.scrollToTop();
  await d.tap({ id: 'diag-target-node' });
  await d.tap({ id: 'diag-run' });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const phase = await d.readText(
      { id: 'diag-request-phase' },
      { maxSwipes: 3 },
    );
    if (/^(completed|failed|cancelled)$/.test(phase ?? '')) return phase;
    await d.sleep(500);
  }
  throw new Error('node request did not finish');
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await step('fresh install, PIN, and a paired reference node', async () => {
    d.adb('install', '-r', apk);
    d.shell('pm', 'clear', d.PACKAGE);
    d.launch();
    await d.waitFor(
      { text: 'Create your private space' },
      { timeoutMs: 60_000 },
    );
    await d.typeInto({ id: 'pin' }, '482915');
    await d.typeInto({ id: 'pin-confirmation' }, '482915');
    await d.hideKeyboard();
    await d.tap({ text: 'Protect my journal' });
    await d.waitFor({ text: 'Settings' }, { timeoutMs: 60_000 });
    node = await startNode({ name: 'AJ F3 Node' });
    await pairWithNode(node);
    await waitForStatus('Connected');
    const shown = actions('connected after pairing');
    expect(
      shown.reconnect === 0,
      `Reconnect beside Connected: ${shown.reconnect}`,
    );
    expect(!shown.notice, 'failure notice while Connected');
    return shown;
  });

  await step(
    'node down, a failed tapped Reconnect: one Reconnect',
    async () => {
      const { port, stateDir } = node;
      await node.stop();
      node = { port, stateDir, stopped: true };
      let phase;
      for (let i = 0; i < 10 && phase !== 'failed'; i += 1) {
        phase = await nodeRequest();
      }
      expect(phase === 'failed', `request with the node down ended ${phase}`);
      await waitForStatus('Unavailable');
      await d.tap({ id: 'reconnect' });
      await d.sleep(3_000);
      await waitForStatus('Unavailable');
      const shown = actions('unavailable after a failed Reconnect');
      expect(shown.reconnect === 1, `Reconnect count ${shown.reconnect}`);
      expect(shown.notice, 'no failure notice after the failed Reconnect');
      expect(
        shown.forgetAndPairAgain === 0,
        'repair offered for a node outage',
      );
      return shown;
    },
  );

  await step(
    'node back, recovered by a node result with no tap: no stale notice',
    async () => {
      node = await startNode({
        name: 'AJ F3 Node',
        stateDir: node.stateDir,
        port: node.port,
      });
      const deadline = Date.now() + 120_000;
      let phase;
      do {
        phase = await nodeRequest();
        if (phase !== 'completed') await d.sleep(2_000);
      } while (phase !== 'completed' && Date.now() < deadline);
      expect(phase === 'completed', `no node result after restart: ${phase}`);
      await waitForStatus('Connected');
      const shown = actions('connected after recovery');
      expect(
        shown.reconnect === 0,
        `Reconnect beside Connected: ${shown.reconnect}`,
      );
      expect(!shown.notice, 'stale failure notice beside Connected');
      return shown;
    },
  );
} finally {
  if (node && !node.stopped) await node.stop().catch(() => undefined);
  fs.writeFileSync(
    path.join(out, 'node-f3.json'),
    JSON.stringify({ apk, results, evidence }, null, 2),
  );
  for (const result of results) {
    process.stdout.write(`AJ1_NODE_F3 ${JSON.stringify(result)}\n`);
  }
  const passed = results.filter(result => result.ok).length;
  process.stdout.write(
    `AJ1_NODE_F3_SUMMARY ${passed}/${results.length} passed\n`,
  );
  process.exitCode = passed === results.length && results.length === 3 ? 0 : 1;
}
