import fs from 'node:fs';
import path from 'node:path';

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(target);
    }
    return /\.tsx?$/.test(entry.name) ? [target] : [];
  });
}

it('uses only the packaged Hybrid AI public entry point', () => {
  const sources = sourceFiles(path.join(__dirname, '..', 'src'));
  const imports = sources.flatMap(file => {
    const text = fs.readFileSync(file, 'utf8');
    return [...text.matchAll(/from\s+['"]([^'"]*hybrid[^'"]*)['"]/gi)].map(
      match => ({ file, module: match[1] }),
    );
  });

  const externalImports = imports.filter(item =>
    item.module.startsWith('@hybrid-ai'),
  );
  // Only the packaged adapter touches the SDK, and only its public root.
  expect(externalImports).toEqual([
    {
      file: path.join(
        __dirname,
        '..',
        'src/platform/hybrid-ai/PackagedHybridAiGateway.ts',
      ),
      module: '@hybrid-ai/react-native',
    },
  ]);
});

it('never reaches SDK internals or the native module directly', () => {
  const sources = sourceFiles(path.join(__dirname, '..', 'src'));
  for (const file of sources) {
    const text = fs.readFileSync(file, 'utf8');
    expect([file, text]).not.toEqual([
      file,
      expect.stringMatching(
        /@hybrid-ai\/react-native\/|NativeHybridAI|TurboModuleRegistry|hybridAi\//,
      ),
    ]);
  }
});

it('adds no cloud, relay, account, or analytics dependency', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
  );
  const names = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  }).join(' ');
  expect(names).not.toMatch(
    /firebase|amplify|auth0|segment|sentry|analytics|mixpanel|amplitude|supabase|aws-sdk|openai|anthropic/i,
  );
});

it('does not introduce account or public-cloud dependencies', () => {
  const packageJson = fs.readFileSync(
    path.join(__dirname, '..', 'package.json'),
    'utf8',
  );
  expect(packageJson).not.toMatch(/firebase|amplify|auth0|segment|sentry/i);
});
