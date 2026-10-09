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
  expect(externalImports).toEqual([
    expect.objectContaining({ module: '@hybrid-ai/react-native' }),
  ]);
});

it('does not introduce account or public-cloud dependencies', () => {
  const packageJson = fs.readFileSync(
    path.join(__dirname, '..', 'package.json'),
    'utf8',
  );
  expect(packageJson).not.toMatch(/firebase|amplify|auth0|segment|sentry/i);
});
