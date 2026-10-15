import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// AJ-RI-2 (GRI-2 AJ row 2, AJ ADR-021/022): transcription runs only through the
// packaged Hybrid AI SDK. Audio Journal ships no Whisper/ggml runtime, no JNI
// speech engine, and no model download; it deploys exactly the accepted
// SDK-defined model pack.
const root = path.join(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const tracked = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard'],
  {
    cwd: root,
    encoding: 'utf8',
  },
)
  .split('\n')
  .filter(file => file && fs.existsSync(path.join(root, file)));

const PINS = {
  model: [
    'ggml-tiny.en-q5_1.bin',
    'c77c5766f1cef09b6b7d47f21b546cbddd4157886b3b5d6d4f709e91e66c7c2b',
  ],
  profile: [
    'sdk.whisper.tiny-en-q5-1.profile.json',
    '5d722be29fe7feae78c7880f12f7e6eae35458e9237753941a3c7d7e54a4e50b',
  ],
  package: [
    'audio-transcribe.tiny-en.package.json',
    'f2f59c4d576acae207646a67b556123c3057c9798a5b97c388b9bef152696544',
  ],
} as const;
const MODEL_BYTES = 32_166_155;

it('builds no app-owned speech engine or model runtime', () => {
  expect(read('android/settings.gradle')).not.toMatch(/speech-engine/);
  const product = tracked.filter(
    file =>
      (file.startsWith('android/') || file.startsWith('src/')) &&
      !file.includes('/androidTest/') &&
      !file.includes('/test/'),
  );
  expect(
    product.filter(
      file =>
        /\.(c|cc|cpp|h|hpp)$|CMakeLists\.txt$/.test(file) &&
        !file.startsWith('android/vault-crypto/'),
    ),
  ).toEqual([]);
  for (const file of product.filter(f =>
    /\.(kt|java|ts|tsx|gradle|pro)$/.test(f),
  )) {
    expect([file, read(file)]).not.toEqual([
      file,
      expect.stringMatching(
        /whisper_|WhisperNative|libaj_whisper|aj_whisper|ggml_|llama_|onnxruntime|System\.loadLibrary\("(?!aj_argon2"|sqlcipher")/,
      ),
    ]);
  }
});

it('downloads no model and provisions only the pinned pack', () => {
  const gradle = read('android/app/build.gradle');
  expect(gradle).not.toMatch(/huggingface|new URL\(|speechModel/i);
  for (const [name, sha256] of Object.values(PINS)) {
    expect(gradle).toContain(`'${name}': [sha256: '${sha256}'`);
  }
  expect(gradle).toContain(`bytes: ${MODEL_BYTES}L`);
  expect(gradle).toContain(
    "def acceptedHybridAiAarSha256 = 'c336b93a181a5dc2982c9e2667b264dbf42d3871ac6a6540287c1bd70c528a49'",
  );
  expect(read('android/gradle.properties')).toContain(
    'hybridAi.transcriptionPackDir=../../hybrid-ai-packages/ri2-a54266a',
  );
});

it('pins the same identities in the native adapter', () => {
  const pins = read(
    'android/app/src/main/java/com/audiojournal/speech/TranscriptionPins.kt',
  );
  expect(pins).toContain(`MODEL_SHA256 = "${PINS.model[1]}"`);
  expect(pins).toContain(`PROFILE_SHA256 = "${PINS.profile[1]}"`);
  expect(pins).toContain(`PACKAGE_SHA256 = "${PINS.package[1]}"`);
  expect(pins).toContain(
    `MODEL_BYTES = ${MODEL_BYTES.toLocaleString('en-US').replace(/,/g, '_')}L`,
  );
  expect(pins).toContain('PROVIDER_REVISION = "v1.9.5+d1be6fde.ri2-decode.1"');
  expect(pins).toContain('DECODE_CONFIG_REVISION = "ri2-decode.1"');
  expect(pins).toContain('MAX_AUDIO_MS = 180_000L');
  // The stored model ID must fit the journal store and AJB1 grammar.
  expect(pins).toContain('MODEL_ID = "${PROFILE_ID}_$PROFILE_VERSION"');
  expect('sdk.whisper.tiny-en-q5-1_1.0.0').toMatch(
    /^[a-z0-9][a-z0-9._-]{0,63}$/,
  );
  expect(read('src/platform/storage/SqliteTranscriptRepository.ts')).toContain(
    '/^[a-z0-9][a-z0-9._-]{0,63}$/',
  );
});

it('uses only the public SDK surface for transcription', () => {
  const dir = 'android/app/src/main/java/com/audiojournal/speech';
  const sources = tracked.filter(file => file.startsWith(dir));
  const imports = new Set(
    sources.flatMap(file =>
      [...read(file).matchAll(/^import (ai\.hybrid\.[\w.]+)/gm)].map(m => m[1]),
    ),
  );
  expect([...imports].sort()).toEqual([
    'ai.hybrid.sdk.ExecuteRequest',
    'ai.hybrid.sdk.ExecutionTarget',
    'ai.hybrid.sdk.HybridAIException',
    'ai.hybrid.sdk.ModelConfigurationDocument',
    'ai.hybrid.sdk.ModelRuntimeConfiguration',
    'ai.hybrid.sdk.NativeExecutionOperation',
    'ai.hybrid.sdk.NativeHybridAIClient',
    'ai.hybrid.sdk.PcmAudioSource',
    'ai.hybrid.sdk.PcmRead',
    'ai.hybrid.sdk.PcmReadStatus',
    'ai.hybrid.sdk.QueuedEvent',
  ]);
  // Local only: the transcription request never names node or auto.
  const engine = read(`${dir}/TranscriptionEngine.kt`);
  expect(engine).toContain('ExecutionTarget.LOCAL');
  expect(engine).not.toMatch(/ExecutionTarget\.(NODE|AUTO)/);
});

const packDir = path.join(root, '..', 'hybrid-ai-packages', 'ri2-a54266a');
(fs.existsSync(packDir) ? it : it.skip)(
  'the staged pack matches its pins on this machine',
  () => {
    for (const [name, sha256] of Object.values(PINS)) {
      const bytes = fs.readFileSync(path.join(packDir, name));
      expect([
        name,
        crypto.createHash('sha256').update(bytes).digest('hex'),
      ]).toEqual([name, sha256]);
    }
    expect(fs.statSync(path.join(packDir, PINS.model[0])).size).toBe(
      MODEL_BYTES,
    );
  },
);
