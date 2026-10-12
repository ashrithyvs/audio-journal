#!/usr/bin/env node
// AJ-2 proof of the frozen Android TLS support profile (SDK ADR-022, Q2)
// against the Audio Journal node companion. The real app and the packaged
// Hybrid AI SDK pair and organize one entry. The companion records every
// handshake it accepts or refuses:
// - API 26–28: TLS 1.2 with ECDHE-ECDSA AES-GCM or ChaCha20-Poly1305, and
//   Extended Master Secret;
// - API 29 and later: TLS 1.3.
//
//   ANDROID_SERIAL=emulator-5560 node e2e/aj2/tls-profile.mjs --apk <app.apk>
//     [--out <dir>]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { pairWithNode, setupPin } from '../android/lib/app.mjs';
import * as d from '../android/lib/device.mjs';
import { startCompanion } from './lib/companion.mjs';
import { done, organize, writeEntry } from './lib/flows.mjs';

const { values: args } = parseArgs({
  options: {
    apk: { type: 'string' },
    out: {
      type: 'string',
      default: fs.mkdtempSync(path.join(os.tmpdir(), 'aj2-tls-')),
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
fs.mkdirSync(args.out, { recursive: true });

// The profile's suites, by their OpenSSL and IANA names (the companion
// reports the IANA standard name).
const TLS12_SUITES = new Set([
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256',
  'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384',
  'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256',
]);
const api = d.apiLevel();
const report = { api, serial: process.env.ANDROID_SERIAL, apk: args.apk };
let node;

// The device log, streamed from before install and launch until after the
// organize result is stored, for the privacy scan. A stream loses nothing to
// buffer pruning or to a refused `logcat -c` (API 26). uiautomator's node
// dumps (test-tool output that repeats on-screen text) are silenced.
const MARK = `AJ_TLS_SMOKE_${Date.now()}`;
try {
  d.shell('setprop', 'log.tag.AccessibilityNodeInfoDumper', 'S');
} catch {
  // filtered below as well
}
const deviceLog = fs.createWriteStream(path.join(args.out, 'device.log'));
const logcat = spawn('adb', [
  '-s',
  process.env.ANDROID_SERIAL,
  'logcat',
  '-v',
  'threadtime',
  '-b',
  'main,system,crash',
  'AccessibilityNodeInfoDumper:S',
  '*:V',
]);
logcat.stdout.pipe(deviceLog);
await d.sleep(1_000);
d.shell('log', '-t', 'AJ_TLS_SMOKE', `${MARK} start`);

async function stopDeviceLog() {
  d.shell('log', '-t', 'AJ_TLS_SMOKE', `${MARK} end`);
  await d.sleep(2_000);
  logcat.kill();
  await new Promise(resolve => deviceLog.end(resolve));
  const text = fs.readFileSync(path.join(args.out, 'device.log'), 'utf8');
  return {
    bytes: text.length,
    lines: text.split('\n').length,
    startMarker: text.includes(`${MARK} start`),
    endMarker: text.includes(`${MARK} end`),
  };
}

try {
  // The clipboard helper pastes the pairing code and the entry text.
  if (fs.existsSync(args.fixture)) d.adb('install', '-r', args.fixture);
  d.adb('install', '-r', args.apk);
  d.shell('pm', 'clear', d.PACKAGE);
  d.launch();
  await d.waitFor({ text: 'Create your private space' }, { timeoutMs: 90_000 });
  await setupPin();
  node = await startCompanion({ name: 'AJ Companion' });
  await pairWithNode(node);
  report.paired = (await node.pairings()).length === 1;

  await writeEntry({
    text: 'I need to renew the car insurance this week.\n\nCall Arjun about the trip.',
  });
  let run;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    run = await organize();
    if (run.result === 'stored') break;
    await done();
    await d.sleep(3_000);
  }
  report.organize = { result: run.result, ms: run.ms };
  report.deviceLog = await stopDeviceLog();

  const handshakes = await node.handshakes();
  report.handshakes = handshakes;
  const accepted = handshakes.filter(h => h.accepted);
  const expected =
    api < 29
      ? h =>
          h.protocol === 'TLSv1.2' &&
          TLS12_SUITES.has(h.cipher) &&
          h.ems === true
      : h => h.protocol === 'TLSv1.3';
  report.checks = {
    paired: report.paired,
    organized: run.result === 'stored',
    handshakes: handshakes.length,
    allAccepted: accepted.length === handshakes.length,
    allOnProfile: handshakes.length > 0 && handshakes.every(expected),
    deviceLogCovered:
      report.deviceLog.startMarker && report.deviceLog.endMarker,
  };
  report.pass = Object.values(report.checks).every(v => v === true || v > 0);
} catch (error) {
  report.pass = false;
  report.error = String(error.message).split('\n').slice(0, 3).join(' / ');
  report.ui = d.snapshot();
} finally {
  if (!report.deviceLog)
    report.deviceLog = await stopDeviceLog().catch(() => null);
  if (node) {
    report.handshakes ??= await node.handshakes().catch(() => []);
    fs.writeFileSync(path.join(args.out, 'companion.log'), node.log.join(''));
    await node.stop();
  }
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(args.out, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  process.stdout.write(
    `API ${api}: ${report.pass ? 'pass' : 'FAIL'} ${JSON.stringify(
      report.checks ?? report.error,
    )}\n`,
  );
  process.exitCode = report.pass ? 0 : 1;
}
