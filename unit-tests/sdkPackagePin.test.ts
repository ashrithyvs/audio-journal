import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { SDK_PACKAGE_VERSION } from '../src/platform/hybrid-ai/PackagedHybridAiGateway';

// AJ-3 evidence must stay reproducible against the accepted M5.5 package
// (`e0fc3c5`, G5-A `07a8bf7`). These checks fail if the app drifts to a live
// SDK working tree or to a different artifact.
const root = path.join(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const packageDir = path.join(root, '..', 'hybrid-ai-packages', 'e0fc3c5');
const TARBALL = 'hybrid-ai-react-native-0.1.0-m5.tgz';
const TARBALL_SHA256 =
  '4761ea3b7fa29b34256fcb03f201b24bd69cf05a59c300b469e82338cafd8b74';
const AAR_SHA256 =
  'ed8ee30c95ce6c30dbea0d4bb98f7003929a5249d2c76defc2fd8cbfe1ed3579';

it('depends on the packed M5 tarball, never on SDK source', () => {
  const manifest = JSON.parse(read('package.json'));
  expect(manifest.dependencies['@hybrid-ai/react-native']).toBe(
    `file:../hybrid-ai-packages/e0fc3c5/${TARBALL}`,
  );
  const lock = JSON.parse(read('package-lock.json'));
  const entry = lock.packages['node_modules/@hybrid-ai/react-native'];
  expect(entry.version).toBe(SDK_PACKAGE_VERSION);
  expect(entry.resolved).toBe(`file:../hybrid-ai-packages/e0fc3c5/${TARBALL}`);
  expect(entry.link).toBeUndefined();
});

it('installed the exact package version the app reports', () => {
  const installed = JSON.parse(
    read('node_modules/@hybrid-ai/react-native/package.json'),
  );
  expect(installed.version).toBe(SDK_PACKAGE_VERSION);
  expect(
    fs
      .lstatSync(path.join(root, 'node_modules/@hybrid-ai/react-native'))
      .isSymbolicLink(),
  ).toBe(false);
});

it('consumes the packaged AAR with a pinned SHA-256, not SDK Gradle source', () => {
  const settings = read('android/settings.gradle');
  expect(settings).not.toMatch(/hybridAi/);
  expect(settings).toMatch(/projectDir = file\('hybrid-ai-android'\)/);
  const properties = read('android/gradle.properties');
  expect(properties).toContain(`hybridAi.aarSha256=${AAR_SHA256}`);
  expect(properties).toContain(
    'hybridAi.aarPath=../../hybrid-ai-packages/e0fc3c5/hybrid-ai-android-release.aar',
  );
  expect(properties).toMatch(/^reactNativeArchitectures=arm64-v8a,x86_64$/m);
});

const describeArtifacts = fs.existsSync(packageDir) ? describe : describe.skip;
describeArtifacts('package directory on this machine', () => {
  const sha256 = (file: string) =>
    crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(packageDir, file)))
      .digest('hex');

  it('matches the SHA-256 values recorded by G5-A', () => {
    expect(sha256(TARBALL)).toBe(TARBALL_SHA256);
    expect(sha256('hybrid-ai-android-release.aar')).toBe(AAR_SHA256);
  });

  it('matches the lockfile integrity', () => {
    const integrity = `sha512-${crypto
      .createHash('sha512')
      .update(fs.readFileSync(path.join(packageDir, TARBALL)))
      .digest('base64')}`;
    const lock = JSON.parse(read('package-lock.json'));
    expect(
      lock.packages['node_modules/@hybrid-ai/react-native'].integrity,
    ).toBe(integrity);
  });
});

it('keeps the SDK repository out of tracked application files', () => {
  const tracked = execFileSync('git', ['ls-files'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(
      file =>
        /\.(ts|tsx|js|gradle|kts|json)$/.test(file) && !file.startsWith('e2e/'),
    );
  for (const file of tracked) {
    if (file === 'package-lock.json' || !fs.existsSync(path.join(root, file)))
      continue;
    expect([file, read(file)]).not.toEqual([
      file,
      expect.stringMatching(/\.\.\/hybridAi\//),
    ]);
  }
});
