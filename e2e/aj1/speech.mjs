// AJ-1 device check of real speech through the production final-pass path
// (LLD §6): RecordingSpeechDeviceTest seals whisper.cpp's public-domain
// `jfk.wav` sample into AJR1 and transcribes it window by window. The sample
// comes from the pinned whisper.cpp source the speech engine already builds
// (android/speech-engine/.cxx/.../_deps/whisper-src/samples), is checked
// against its SHA-256, and is pushed to /data/local/tmp/aj1-speech, where the
// test reads it through the instrumentation's shell access; no audio is
// committed. Requires the debug app and test APKs
// (`./gradlew assembleDebug assembleDebugAndroidTest`).
//
//   ANDROID_SERIAL=emulator-5554 node e2e/aj1/speech.mjs

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { adb, PACKAGE, shell } from '../android/lib/device.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAMPLE_SHA256 =
  '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e';
const TEST = 'com.audiojournal.speech.RecordingSpeechDeviceTest';

function sample() {
  const cxx = join(ROOT, 'android', 'speech-engine', '.cxx');
  for (const build of ['Release', 'Debug']) {
    let hashes = [];
    try {
      hashes = readdirSync(join(cxx, build));
    } catch {
      continue;
    }
    for (const hash of hashes) {
      for (const abi of readdirSync(join(cxx, build, hash))) {
        const file = join(
          cxx,
          build,
          hash,
          abi,
          '_deps',
          'whisper-src',
          'samples',
          'jfk.wav',
        );
        try {
          const bytes = readFileSync(file);
          if (
            createHash('sha256').update(bytes).digest('hex') === SAMPLE_SHA256
          )
            return file;
        } catch {
          // Not in this build directory.
        }
      }
    }
  }
  throw new Error(
    'jfk.wav with the pinned SHA-256 not found; build the speech engine first',
  );
}

const apks = join(ROOT, 'android', 'app', 'build', 'outputs', 'apk');
adb('install', '-r', '-t', join(apks, 'debug', 'app-debug.apk'));
adb(
  'install',
  '-r',
  '-t',
  join(apks, 'androidTest', 'debug', 'app-debug-androidTest.apk'),
);
const target = '/data/local/tmp/aj1-speech';
shell('mkdir', '-p', target);
adb('push', sample(), `${target}/jfk.wav`);
const started = Date.now();
const output = shell(
  'am',
  'instrument',
  '-w',
  '-r',
  '-e',
  'class',
  TEST,
  `${PACKAGE}.test/androidx.test.runner.AndroidJUnitRunner`,
);
const ms = Date.now() - started;
shell('rm', '-rf', target);
// Raw status codes: 1 started, 0 passed, -2 failed, -3 ignored, -4 assumption.
const codes = [...output.matchAll(/INSTRUMENTATION_STATUS_CODE: (-?\d+)/g)].map(
  match => Number(match[1]),
);
const skipped = codes.includes(-3) || codes.includes(-4);
const ok = codes.includes(0) && !codes.some(code => code < 0);
process.stdout.write(
  `AJ1_SPEECH ${JSON.stringify({
    test: TEST,
    ok: ok && !skipped,
    skipped,
    ms,
  })}\n`,
);
if (!ok || skipped) {
  process.stdout.write(output.split('\n').slice(-40).join('\n'));
  process.exitCode = 1;
}
