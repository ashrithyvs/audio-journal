import fs from 'node:fs';
import path from 'node:path';

// AJ-1 and AJ-2 domain, port, and storage code stays platform-free: no React
// Native, no Node built-ins, no Hybrid AI, and no reach into other feature
// internals. The organize domain also reads its pinned contract schemas.

const root = path.join(__dirname, '..');
const layers = [
  'src/features/journal/domain',
  'src/features/journal/ports',
  'src/features/journal/application',
  'src/features/backup/domain',
  'src/features/organize/domain',
  'src/features/organize/ports',
  'src/platform/storage',
];
const storageFree = layers.filter(layer => layer !== 'src/platform/storage');

function files(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    const full = path.join(directory, item.name);
    return item.isDirectory()
      ? files(full)
      : /\.tsx?$/.test(item.name)
      ? [full]
      : [];
  });
}

const imports = (file: string) =>
  [...fs.readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)].map(m => m[1]);

it('imports only relative modules inside the allowed layers', () => {
  for (const layer of layers) {
    for (const file of files(path.join(root, layer))) {
      for (const specifier of imports(file)) {
        // React providers live in application/; nothing else is external.
        if (specifier === 'react' && layer.endsWith('/application')) {
          continue;
        }
        expect([file, specifier]).toEqual([
          file,
          expect.stringMatching(/^\.\.?\//),
        ]);
        const target = path.relative(
          root,
          path.resolve(path.dirname(file), specifier),
        );
        // Storage may also reach its own native driver spec, nothing else native.
        if (
          layer === 'src/platform/storage' &&
          target === 'src/native/NativeAudioJournalStore'
        ) {
          continue;
        }
        expect([file, target]).toEqual([
          file,
          expect.stringMatching(
            /^(src\/(features\/journal\/(domain|ports|application)|features\/backup\/domain|features\/organize\/(domain|ports)|platform\/storage)|schemas\/journal\/v1)\//,
          ),
        ]);
      }
    }
  }
});

it('keeps domain, ports, and application free of storage implementations', () => {
  for (const layer of storageFree) {
    for (const file of files(path.join(root, layer))) {
      for (const specifier of imports(file)) {
        expect([file, specifier]).not.toEqual([
          file,
          expect.stringContaining('platform/'),
        ]);
      }
    }
  }
});

it('never logs from domain or storage code', () => {
  for (const layer of layers) {
    for (const file of files(path.join(root, layer))) {
      expect([file, fs.readFileSync(file, 'utf8')]).not.toEqual([
        file,
        expect.stringMatching(/console\.|debugger/),
      ]);
    }
  }
});

it('keeps invisible control, format, and bidi characters out of AJ-1 source', () => {
  // Escapes such as "\\u202e" are fine; the literal characters are not, because
  // they render invisibly or reorder code in review (Trojan Source).
  const invisible = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
  const testFiles = [
    'unit-tests',
    'integration-tests',
    'smoke-tests',
    'performance-tests',
    'test',
  ]
    .flatMap(directory => files(path.join(root, directory)))
    .filter(file => /journal|backup/i.test(path.basename(file)));
  for (const file of [
    ...layers.flatMap(layer => files(path.join(root, layer))),
    ...testFiles,
  ]) {
    const text = fs.readFileSync(file, 'utf8').replace(/\n/g, '');
    expect([file, invisible.test(text)]).toEqual([file, false]);
  }
});

it('keeps invisible characters and unusual spaces out of the native sources', () => {
  // Kotlin, C, and CMake sources of the app. Besides controls, format, and
  // bidi characters, any space other than U+0020 is refused: a no-break or
  // other Unicode space looks like a space in review but is not one.
  const nativeRoots = [
    'android/app/src/main/java',
    'android/app/src/test/java',
    'android/app/src/androidTest/java',
    'android/vault-crypto',
  ];
  const sources = nativeRoots
    .flatMap(directory => nativeFiles(path.join(root, directory)))
    .filter(file => /\.(kt|c|cpp|h|txt|gradle)$/.test(file));
  expect(sources.length).toBeGreaterThan(10);
  const hidden = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/u;
  for (const file of sources) {
    const text = fs.readFileSync(file, 'utf8').replace(/[\n ]/g, '');
    expect([file, hidden.test(text)]).toEqual([file, false]);
  }
});

function nativeFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    const full = path.join(directory, item.name);
    if (item.isDirectory()) {
      return item.name === 'build' || item.name === '.cxx'
        ? []
        : nativeFiles(full);
    }
    return [full];
  });
}
