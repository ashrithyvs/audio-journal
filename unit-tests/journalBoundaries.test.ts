import fs from 'node:fs';
import path from 'node:path';

// AJ-1 domain, port, and storage code stays platform-free: no React Native,
// no Node built-ins, no Hybrid AI, and no reach into other feature internals.

const root = path.join(__dirname, '..');
const layers = [
  'src/features/journal/domain',
  'src/features/journal/ports',
  'src/features/journal/application',
  'src/features/backup/domain',
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
        expect([file, target]).toEqual([
          file,
          expect.stringMatching(
            /^src\/(features\/journal\/(domain|ports|application)|features\/backup\/domain|platform\/storage)\//,
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
