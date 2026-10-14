// Voice-entry helpers shared by the AJ-2 device journeys: the pinned speech
// sample, capture through the `e2e` build's test input, and reading texts
// that uiautomator lists as separate child nodes.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import * as d from '../../android/lib/device.mjs';
import {
  liveDump,
  liveTap,
  liveTextOf,
  liveWaitFor,
} from '../../aj1/lib/liveScreen.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SAMPLE_SHA256 =
  '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e';
export const INPUT = `/sdcard/Android/data/${d.PACKAGE}/files/test-audio`;

/**
 * The pinned sample (whisper.cpp's public-domain `jfk.wav`). AJ-RI-2 removed the
 * app's speech engine, so its source tree is no longer built here: pass the
 * file as `AJ_VOICE_SAMPLE`; the old engine tree is still searched if present.
 */
export function sample() {
  const cxx = path.join(ROOT, 'android', 'speech-engine', '.cxx');
  const found = process.env.AJ_VOICE_SAMPLE
    ? [process.env.AJ_VOICE_SAMPLE]
    : [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (full.endsWith(path.join('whisper-src', 'samples', 'jfk.wav')))
        found.push(full);
    }
  };
  if (fs.existsSync(cxx)) walk(cxx);
  const file = found.find(
    f =>
      createHash('sha256').update(fs.readFileSync(f)).digest('hex') ===
      SAMPLE_SHA256,
  );
  if (!file) throw new Error('jfk.wav with the pinned SHA-256 not found');
  return file;
}

export const seconds = text => {
  const match = /(\d+):(\d\d)/.exec(text ?? '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
};

/** The texts drawn inside a node (uiautomator lists children separately). */
export function textsWithin(id) {
  const nodes = liveDump();
  const box = nodes.find(n => n.id === id)?.bounds;
  if (!box) return [];
  return nodes
    .filter(
      n =>
        n.text &&
        n.bounds &&
        n.bounds[0] >= box[0] &&
        n.bounds[1] >= box[1] &&
        n.bounds[2] <= box[2] &&
        n.bounds[3] <= box[3],
    )
    .map(n => n.text);
}

/**
 * Records the sample through the app's capture path and opens the entry.
 * The `e2e` build creates INPUT as the app when the journal opens; a
 * directory made by `adb shell` would not be readable to the app.
 */
export async function recordSample() {
  if (d.shell('ls', '-d', INPUT).trim() !== INPUT) {
    throw new Error('the e2e build did not create its test input directory');
  }
  d.adb('push', sample(), `${INPUT}/input.wav`);
  // Switching tabs returns to the Diary stack as it was left; tapping the
  // focused tab again pops it to the timeline.
  await d.tap({ text: 'Diary' });
  for (let i = 0; i < 3 && !d.find(d.dump(), { id: 'diary-record' }); i += 1) {
    await d.tap({ text: 'Diary' });
    await d.sleep(500);
  }
  await d.tap({ id: 'diary-record' });
  await liveWaitFor({ id: 'recording-pause' }, { timeoutMs: 30_000 });
  await d.sleep(13_000); // the 11 s sample, then silence
  await liveTap({ id: 'recording-finish' });
  await liveWaitFor({ id: 'recording-open-entry' }, { timeoutMs: 30_000 });
  const captured = seconds(liveTextOf({ id: 'recording-timer' }));
  if (!(captured >= 12)) throw new Error(`captured only ${captured} s`);
  if (d.shell('ls', INPUT).includes('input.wav')) {
    throw new Error('the capture did not read the test input');
  }
  await liveTap({ id: 'recording-open-entry' });
  await liveWaitFor({ id: 'entry-recording' }, { timeoutMs: 30_000 });
  return captured;
}
